"use client";
import { useEffect, useState, useCallback, useRef } from "react";
import DateRangePicker from "./DateRangePicker";
import { useDateField } from "@/lib/date-field-context";
import { calcularUltimos7Dias, DATE_PRESETS } from "@/lib/date-range-utils";
import { ASYNC_SYNC_JOBS_ENABLED } from "@/lib/feature-flags";

// ── Tipos ──────────────────────────────────────────────────────────────────
interface VendaRow {
  orderId:        string;
  data:           string;
  anuncio:        string;
  conta:          string;
  marketplace:    string;
  sku:            string | null;
  mlItemId:       string;
  frete:          "gratis" | "comprador";
  logistica:      string;
  status:         "paid" | "cancelled" | "devolucao" | "pending";
  valorUnit:      number;
  qtd:            number;
  faturamento:    number;
  custo:          number;
  imposto:        number;
  tarifaVenda:    number;
  freteComprador: number;
  freteVendedor:  number;
  margemContrib:  number;
  mcPercent:      number;
  cadastrado:     boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────
const moeda = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

const pct = (v: number) => `${v.toFixed(1)}%`;

// ── Componente ─────────────────────────────────────────────────────────────
export default function VendasPage() {
  // Padrão de abertura (aprovado 2026-07-10): Últimos 7 dias, via fonte
  // única lib/date-range-utils.ts — corrige bug real (esta linha calculava
  // 8 dias antes, via "hoje - 7"; agora usa a mesma função do Dashboard e
  // do DateRangePicker, garantindo os mesmos 7 dias nas três telas).
  const ultimos7 = calcularUltimos7Dias();
  const hoje     = ultimos7.to;

  const [dateFrom,  setDateFrom]  = useState(ultimos7.from);
  const [dateTo,    setDateTo]    = useState(ultimos7.to);
  // Fase D (2026-07-06): seletor global (TopBar) — afeta a tabela e os cards desta página.
  const { dateField } = useDateField();
  const [skuTags,  setSkuTags]  = useState<string[]>([]);
  const [skuInput, setSkuInput] = useState("");
  const [lojaAtiva, setLojaAtiva] = useState<"todos" | "ML" | "Shopee">("todos");
  const [plataformaOpen, setPlataformaOpen] = useState(false);
  const [cadastroOpen, setCadastroOpen] = useState(false);
  const [filtrosCadastro, setFiltrosCadastro] = useState<string[]>([]);
  const [statusOpen, setStatusOpen] = useState(false);
  const [filtrosStatus, setFiltrosStatus] = useState<string[]>([]);
  const [envioOpen, setEnvioOpen] = useState(false);
  const [filtrosEnvio, setFiltrosEnvio] = useState<string[]>([]);
  // Fase de redesenho do botão Sincronizar (aprovado 2026-07-11): rows
  // separado por marketplace — cada um só é sobrescrito quando SUA
  // própria leitura tiver sucesso, nunca zerado pela falha do outro.
  // Corrige o bug em que uma falha/timeout num marketplace derrubava o
  // faturamento total (o array combinado inteiro era substituído).
  const [mlRows,     setMlRows]     = useState<VendaRow[]>([]);
  const [shopeeRows, setShopeeRows] = useState<VendaRow[]>([]);
  const rows = [...mlRows, ...shopeeRows].sort((a, b) => b.data.localeCompare(a.data));
  const [mlLojaId,     setMlLojaId]     = useState<string | null>(null);
  const [shopeeLojaId, setShopeeLojaId] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [erro,      setErro]      = useState<string | null>(null);
  const [semConexao, setSemConexao] = useState(false);
  const [erroShopee, setErroShopee] = useState(false);
  const [erroShopeeMsg, setErroShopeeMsg] = useState<string | null>(null);
  const [shopeeSemDados, setShopeeSemDados] = useState(false);
  const [totalPedidos, setTotalPedidos] = useState(0);
  const [conta,      setConta]    = useState("");
  const [ultimaSync, setUltimaSync] = useState<string | null>(null);
  // "atualizando" (job de sync via botão) é distinto de "loading" (leitura
  // inicial/normal) — regra aprovada 2026-07-11.
  const [atualizando, setAtualizando] = useState<{ ml: boolean; shopee: boolean }>({ ml: false, shopee: false });
  const [syncMsg, setSyncMsg] = useState<{ ml: string | null; shopee: string | null }>({ ml: null, shopee: null });
  const pollTimers = useRef<{ ml: number | null; shopee: number | null }>({ ml: null, shopee: null });

  // ── Histórico ──────────────────────────────────────────────────────────────
  const [historicoOpen,   setHistoricoOpen]   = useState(false);
  const [historicoDesde,  setHistoricoDesde]  = useState(() => {
    // Padrão: 2 meses atrás (onboarding cobre o período útil sem sobrecarregar)
    const d = new Date();
    d.setMonth(d.getMonth() - 2);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  // Onboarding: true enquanto o usuário não tiver feito ao menos 1 sync de histórico
  const [onboardingPendente, setOnboardingPendente] = useState(() => {
    if (typeof window === "undefined") return false;
    return !localStorage.getItem("historico_concluido_v1");
  });
  // historicoLoja removido — sempre sincroniza todas as plataformas
  type MesStatus = "pendente" | "sincronizando" | "ok" | "erro";
  const [historicoMeses, setHistoricoMeses] = useState<{
    label: string; from: string; to: string; status: MesStatus;
    count?: number; erro?: string;
    diasOk?: number; diasTotal?: number; // progresso dia-a-dia dentro do mês
  }[]>([]);
  const [historicoRodando, setHistoricoRodando] = useState(false);
  const cancelRef = useRef(false);

  // ── Sync Rápido (preset buttons) ────────────────────────────────────────
  const [quickSyncRodando, setQuickSyncRodando] = useState(false);
  const [quickSyncPreset,  setQuickSyncPreset]  = useState("");
  const [quickSyncFrom,    setQuickSyncFrom]    = useState("");
  const [quickSyncTo,      setQuickSyncTo]      = useState("");
  // Personalizado (aprovado 2026-07-10): datas digitadas manualmente, sem
  // nenhum cálculo de "hoje"/soma de dias — não é lógica local de datas,
  // é apenas o valor que o usuário escolheu.
  const [personalizadoAberto, setPersonalizadoAberto] = useState(false);
  const [personalizadoFrom,   setPersonalizadoFrom]   = useState("");
  const [personalizadoTo,     setPersonalizadoTo]     = useState("");
  const [quickSyncDias, setQuickSyncDias] = useState<{
    label: string; from: string; to: string; status: MesStatus; count?: number; erro?: string;
  }[]>([]);

  // Estado do teste rápido (1 dia)
  const [testeRodando, setTesteRodando]   = useState(false);
  const [testeResult,  setTesteResult]    = useState<{ ok: boolean; msg: string } | null>(null);

  function gerarMeses(desde: string): { label: string; from: string; to: string; status: MesStatus }[] {
    const meses = [];
    const hoje = new Date();
    const [startY, startM] = desde.split("-").map(Number);
    let y = startY, m = startM;
    while (y < hoje.getFullYear() || (y === hoje.getFullYear() && m <= hoje.getMonth() + 1)) {
      const from = `${y}-${String(m).padStart(2, "0")}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const to   = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;
      const label = new Date(y, m - 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
      meses.push({ label, from, to, status: "pendente" as MesStatus });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return meses.reverse(); // mais recente primeiro
  }

  // Divide um range em janelas de 7 dias (garante 1 chunk Shopee por request)
  function gerarJanelas(from: string, to: string): Array<{ from: string; to: string }> {
    const addDays = (iso: string, n: number) => {
      const d = new Date(`${iso}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().split("T")[0];
    };
    const janelas: Array<{ from: string; to: string }> = [];
    let cur = from;
    while (cur <= to) {
      const end = addDays(cur, 0); // 1 dia por janela (sem buffer + 1 dia = volume controlado)
      janelas.push({ from: cur, to: end > to ? to : end });
      cur = addDays(end, 1);
    }
    return janelas;
  }

  // Faz uma chamada ao sync com timeout seguro
  async function syncJanela(from: string, to: string): Promise<{ ml: number; shopee: number; erro?: string }> {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 58000); // 58s — alinhado ao maxDuration=60 do Vercel
    try {
      const res = await fetch("/api/sync/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateFrom: from, dateTo: to, marketplace: "todos", noBuffer: true }),
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      let data: any = {};
      try { data = await res.json(); } catch { data = { erro: true, mensagem: `HTTP ${res.status}` }; }
      const erro = data.mlErro || data.shopeeErro || (data.erro ? (data.mensagem ?? "Erro") : undefined);
      return { ml: data.ml ?? 0, shopee: data.shopee ?? 0, erro };
    } catch (e: any) {
      clearTimeout(tid);
      return { ml: 0, shopee: 0, erro: e?.name === "AbortError" ? "Timeout (>58s)" : (e?.message ?? "Falha") };
    }
  }

  async function iniciarSyncRapido(from: string, to: string, preset: string) {
    const janelas = gerarJanelas(from, to);
    const dias = janelas.map(j => {
      const [yy, mm, dd] = j.from.split("-");
      return { label: `${dd}/${mm}/${yy.slice(2)}`, from: j.from, to: j.to, status: "pendente" as MesStatus };
    });
    setQuickSyncDias(dias);
    setQuickSyncPreset(preset);
    setQuickSyncFrom(from);
    setQuickSyncTo(to);
    setQuickSyncRodando(true);
    cancelRef.current = false;

    for (let i = 0; i < janelas.length; i++) {
      if (cancelRef.current) break;
      setQuickSyncDias(prev => prev.map((d, idx) => idx === i ? { ...d, status: "sincronizando" } : d));
      const result = await syncJanela(janelas[i].from, janelas[i].to);
      setQuickSyncDias(prev => prev.map((d, idx) =>
        idx === i ? { ...d, status: result.erro ? "erro" : "ok", count: (result.ml ?? 0) + (result.shopee ?? 0), erro: result.erro } : d
      ));
    }
    setQuickSyncRodando(false);
  }

  async function iniciarHistorico() {
    const meses = gerarMeses(historicoDesde);
    setHistoricoMeses(meses);
    setHistoricoRodando(true);
    cancelRef.current = false;
    let algumaOk = false;

    for (let i = 0; i < meses.length; i++) {
      if (cancelRef.current) break;

      setHistoricoMeses(prev => prev.map((m, idx) =>
        idx === i ? { ...m, status: "sincronizando" } : m
      ));

      const janelas = gerarJanelas(meses[i].from, meses[i].to);
      let totalMl = 0, totalShopee = 0, erroMes: string | undefined;
      let diasOk = 0; const diasTotal = janelas.length;

      for (const janela of janelas) {
        if (cancelRef.current) break;
        const t0 = Date.now();
        const result = await syncJanela(janela.from, janela.to);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        totalMl     += result.ml;
        totalShopee += result.shopee;
        if (result.erro && !erroMes) {
          erroMes = `${janela.from}: ${result.erro} (${elapsed}s)`;
        } else {
          diasOk++;
        }
        // Atualiza progresso dia-a-dia dentro do mês
        setHistoricoMeses(prev => prev.map((m, idx) =>
          idx === i ? { ...m, diasOk, diasTotal } : m
        ));
      }

      const count = totalMl + totalShopee;
      if (!erroMes) algumaOk = true;
      setHistoricoMeses(prev => prev.map((m, idx) =>
        idx === i ? { ...m, status: erroMes ? "erro" : "ok", count, erro: erroMes, diasOk, diasTotal } : m
      ));
    }
    setHistoricoRodando(false);
    if (algumaOk) {
      try { localStorage.setItem("historico_concluido_v1", "1"); } catch {}
      setOnboardingPendente(false);
    }
  }

  // Reprocessa apenas os meses que falharam
  async function reprocessarErros() {
    const comErro = historicoMeses.filter(m => m.status === "erro");
    if (comErro.length === 0 || historicoRodando) return;
    setHistoricoRodando(true);
    cancelRef.current = false;
    let algumaOk = false;
    for (const mes of comErro) {
      if (cancelRef.current) break;
      const idx = historicoMeses.findIndex(m => m.from === mes.from);
      setHistoricoMeses(prev => prev.map((m, i) =>
        i === idx ? { ...m, status: "sincronizando", erro: undefined } : m
      ));
      const janelas = gerarJanelas(mes.from, mes.to);
      let totalMl = 0, totalShopee = 0, erroMes: string | undefined;
      let diasOk = 0; const diasTotal = janelas.length;
      for (const janela of janelas) {
        if (cancelRef.current) break;
        const t0 = Date.now();
        const result = await syncJanela(janela.from, janela.to);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        totalMl += result.ml; totalShopee += result.shopee;
        if (result.erro && !erroMes) {
          erroMes = `${janela.from}: ${result.erro} (${elapsed}s)`;
        } else {
          diasOk++;
        }
        setHistoricoMeses(prev => prev.map((m, i) =>
          i === idx ? { ...m, diasOk, diasTotal } : m
        ));
      }
      const count = totalMl + totalShopee;
      if (!erroMes) algumaOk = true;
      setHistoricoMeses(prev => prev.map((m, i) =>
        i === idx ? { ...m, status: erroMes ? "erro" : "ok", count, erro: erroMes, diasOk, diasTotal } : m
      ));
    }
    setHistoricoRodando(false);
    if (algumaOk) {
      try { localStorage.setItem("historico_concluido_v1", "1"); } catch {}
      setOnboardingPendente(false);
    }
  }

  // ── Teste rápido: sincroniza ontem (1 dia) para validar configuração ─────────
  async function testarSync() {
    setTesteRodando(true);
    setTesteResult(null);
    const ontemDate = new Date(Date.now() - 3 * 60 * 60 * 1000);
    ontemDate.setDate(ontemDate.getDate() - 1);
    const ontem = ontemDate.toISOString().split("T")[0];
    const t0 = Date.now();
    const result = await syncJanela(ontem, ontem);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.erro) {
      setTesteResult({ ok: false, msg: `❌ ${result.erro} (${elapsed}s)` });
    } else {
      setTesteResult({ ok: true, msg: `✅ ${result.ml + result.shopee} pedidos em ${elapsed}s — tudo ok!` });
    }
    setTesteRodando(false);
  }

  const LOJAS = [
    { key: "todos",  label: "Todas",         cor: "#d7dbe5", bg: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.2)" },
    { key: "ML",     label: "Mercado Livre", cor: "#FFE600", bg: "rgba(255,230,0,0.12)",  border: "#FFE600"                },
    { key: "Shopee", label: "Shopee",        cor: "#EE4D2D", bg: "rgba(238,77,45,0.12)",  border: "#EE4D2D"                },
  ] as const;

  function addSkuTag() {
    const val = skuInput.trim().toUpperCase();
    if (val && !skuTags.includes(val)) setSkuTags(prev => [...prev, val]);
    setSkuInput("");
  }

  function removeSkuTag(tag: string) {
    setSkuTags(prev => prev.filter(t => t !== tag));
  }

  // Lê o cache de UM marketplace por vez. Nunca sobrescreve nem zera as
  // linhas do OUTRO marketplace, e — em caso de falha/timeout deste
  // marketplace — nunca zera as próprias linhas já exibidas: só atualiza
  // quando a leitura tem sucesso. Correção aprovada 2026-07-11: a antiga
  // função `sync()` combinava os dois marketplaces num único array e
  // substituía tudo de uma vez, então uma falha isolada (ex: timeout da
  // Shopee) derrubava o faturamento total mesmo com o ML saudável.
  const lerMarketplace = useCallback(async (
    mkt: "ML" | "Shopee",
    from: string, to: string, tags: string[], filtros: string[] = [],
    force = false
  ) => {
    const params = new URLSearchParams({ date_from: from, date_to: to, date_field: dateField });
    if (tags.length > 0) params.set("sku", tags.join(","));
    const needsCancelled = filtros.includes("canceladas") || filtros.includes("devolucoes");
    if (needsCancelled) params.set("include_cancelled", "true");
    // force=true (fluxo antigo, ENABLE_ASYNC_SYNC_JOBS=false — ver
    // docs/DECISIONS.md 2026-07-13): pede sync inline na própria rota de
    // leitura, exatamente como funcionava antes de 2026-07-11. Continua se
    // beneficiando da separação mlRows/shopeeRows abaixo — uma falha aqui
    // não zera o outro marketplace nem os dados já exibidos deste.
    if (force) params.set("sync", "1");

    const url  = mkt === "ML" ? `/api/ml/vendas?${params}` : `/api/shopee/vendas?${params}`;
    const ctrl = new AbortController();
    // force=true faz sync inline (pode levar bem mais que uma leitura de
    // cache) — mesmo timeout generoso que o antigo forceSync já usava.
    const tid  = setTimeout(() => ctrl.abort(), 45000);
    let data: any = null;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      data = await res.json();
    } catch {
      data = null;
    } finally {
      clearTimeout(tid);
    }

    const falhou = !data || data.erro;

    if (mkt === "ML") {
      if (data?.lojaId) setMlLojaId(data.lojaId);
      if (!falhou) setMlRows((data.rows ?? []) as VendaRow[]);
      // falha no ML: mlRows permanece como estava — nunca zera.
    } else {
      if (data?.lojaId) setShopeeLojaId(data.lojaId);
      setErroShopee(!!falhou);
      setErroShopeeMsg(falhou ? (data?.mensagem ?? null) : null);
      setShopeeSemDados(!falhou && !!data?.semDados);
      if (!falhou) setShopeeRows((data.rows ?? []) as VendaRow[]);
      // falha na Shopee: shopeeRows permanece como estava — nunca zera.
    }

    return { falhou, data };
  }, [dateField]);

  // Orquestra a leitura normal (montagem, mudança de filtro/data/date_field,
  // "Buscar", "Limpar"). NÃO dispara sincronização — só lê o cache atual.
  // Disparo de sync é responsabilidade separada: ver dispararSincronizar().
  const refetchTudo = useCallback(async (
    from: string, to: string, tags: string[], filtros: string[] = [],
    loja: "todos" | "ML" | "Shopee" = "todos"
  ) => {
    setLoading(true);
    setErro(null);
    try {
      const lerML     = loja === "todos" || loja === "ML";
      const lerShopee = loja === "todos" || loja === "Shopee";

      const [resML, resShopee] = await Promise.all([
        lerML     ? lerMarketplace("ML",     from, to, tags, filtros) : Promise.resolve(null),
        lerShopee ? lerMarketplace("Shopee", from, to, tags, filtros) : Promise.resolve(null),
      ]);

      const mlFalhou     = lerML     && resML?.falhou;
      const shopeeFalhou = lerShopee && resShopee?.falhou;

      // "Nenhuma conta conectada" só faz sentido quando não há NENHUM dado
      // já exibido — se já havia linhas na tela, uma falha dupla e
      // temporária não deve substituir a tabela pela tela de "desconectado"
      // (mesma regra de preservação, aplicada também a este estado).
      setSemConexao(!!(mlFalhou && shopeeFalhou) && mlRows.length === 0 && shopeeRows.length === 0);

      if (!(mlFalhou && shopeeFalhou)) {
        const dML     = resML?.data;
        const dShopee = resShopee?.data;
        setTotalPedidos((dML?.totalPedidos ?? 0) + (dShopee?.totalPedidos ?? 0));
        const rawConta = dML?.conta || dShopee?.conta || "";
        const contaNorm = rawConta.toLowerCase().replace(/(?:^|\s)\S/g, (c: string) => c.toUpperCase());
        setConta(contaNorm);
        setUltimaSync(new Date().toLocaleTimeString("pt-BR"));
      }
    } catch {
      setErro("Falha na conexão.");
    } finally {
      setLoading(false);
    }
  }, [lerMarketplace, mlRows.length, shopeeRows.length]); // eslint-disable-line

  // ── Disparo de sincronização (botão "Sincronizar") ──────────────────────
  // Separado da leitura (refetchTudo/lerMarketplace) — aprovado 2026-07-11.
  // POST /api/sync/iniciar cria/reaproveita um job persistente; o polling
  // consulta job_id (nunca loja_id — evita confundir com um job antigo já
  // concluído). Job concluído → refaz a leitura só daquele marketplace.
  // Job com erro/timeout → mensagem discreta, dados antigos preservados.
  function chaveMkt(mkt: "ML" | "Shopee"): "ml" | "shopee" {
    return mkt === "ML" ? "ml" : "shopee";
  }

  function pararPolling(mkt: "ML" | "Shopee") {
    const chave = chaveMkt(mkt);
    if (pollTimers.current[chave] != null) {
      clearTimeout(pollTimers.current[chave]!);
      pollTimers.current[chave] = null;
    }
  }

  function pollStatus(mkt: "ML" | "Shopee", jobId: string, tentativa = 0) {
    const chave = chaveMkt(mkt);
    const POLL_MS = 3000;
    const MAX_TENTATIVAS = 200; // ~10 minutos de polling

    fetch(`/api/sync/status?job_id=${jobId}`)
      .then(res => res.json())
      .then(data => {
        if (data.status === "concluido") {
          setAtualizando(prev => ({ ...prev, [chave]: false }));
          setSyncMsg(prev => ({ ...prev, [chave]: null }));
          lerMarketplace(mkt, dateFrom, dateTo, skuTags, [...filtrosCadastro, ...filtrosStatus]);
          return;
        }
        if (data.status === "erro") {
          setAtualizando(prev => ({ ...prev, [chave]: false }));
          setSyncMsg(prev => ({ ...prev, [chave]: "Não foi possível atualizar agora. Os dados anteriores continuam disponíveis." }));
          return;
        }
        // "pendente"/"rodando"/"idle" → continua tentando
        if (tentativa >= MAX_TENTATIVAS) {
          setAtualizando(prev => ({ ...prev, [chave]: false }));
          setSyncMsg(prev => ({ ...prev, [chave]: "A atualização está demorando mais que o esperado. Os dados anteriores continuam disponíveis." }));
          return;
        }
        pollTimers.current[chave] = window.setTimeout(() => pollStatus(mkt, jobId, tentativa + 1), POLL_MS);
      })
      .catch(() => {
        if (tentativa >= MAX_TENTATIVAS) {
          setAtualizando(prev => ({ ...prev, [chave]: false }));
          setSyncMsg(prev => ({ ...prev, [chave]: "Não foi possível confirmar a atualização. Os dados anteriores continuam disponíveis." }));
          return;
        }
        pollTimers.current[chave] = window.setTimeout(() => pollStatus(mkt, jobId, tentativa + 1), POLL_MS);
      });
  }

  async function dispararUm(mkt: "ML" | "Shopee") {
    const chave  = chaveMkt(mkt);
    const lojaId = mkt === "ML" ? mlLojaId : shopeeLojaId;

    if (!lojaId) {
      setSyncMsg(prev => ({ ...prev, [chave]: "Loja não identificada ainda — aguarde o carregamento ou recarregue a página." }));
      return;
    }

    pararPolling(mkt);
    setAtualizando(prev => ({ ...prev, [chave]: true }));
    setSyncMsg(prev => ({ ...prev, [chave]: null }));

    try {
      const res  = await fetch("/api/sync/iniciar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ loja_id: lojaId }),
      });
      const data = await res.json();

      if (!data.ok || !data.job_id) {
        setAtualizando(prev => ({ ...prev, [chave]: false }));
        setSyncMsg(prev => ({ ...prev, [chave]: "Não foi possível iniciar a atualização. Os dados anteriores continuam disponíveis." }));
        return;
      }
      pollStatus(mkt, data.job_id);
    } catch {
      setAtualizando(prev => ({ ...prev, [chave]: false }));
      setSyncMsg(prev => ({ ...prev, [chave]: "Não foi possível iniciar a atualização. Os dados anteriores continuam disponíveis." }));
    }
  }

  // Fluxo antigo (ENABLE_ASYNC_SYNC_JOBS=false — aprovado 2026-07-13, ver
  // docs/DECISIONS.md): sem job/worker, chama lerMarketplace(force=true)
  // direto — mesmo comportamento de antes de 2026-07-11 (sync=1 embutido na
  // rota de leitura), mas já se beneficiando da separação mlRows/shopeeRows
  // (uma falha num marketplace não derruba o outro nem zera dados antigos).
  async function dispararSincronizarInline() {
    const alvosML     = lojaAtiva === "todos" || lojaAtiva === "ML";
    const alvosShopee = lojaAtiva === "todos" || lojaAtiva === "Shopee";

    setAtualizando(prev => ({
      ...prev,
      ml:     alvosML     ? true : prev.ml,
      shopee: alvosShopee ? true : prev.shopee,
    }));
    setSyncMsg(prev => ({
      ml:     alvosML     ? null : prev.ml,
      shopee: alvosShopee ? null : prev.shopee,
    }));

    const filtros = [...filtrosCadastro, ...filtrosStatus];
    try {
      await Promise.all([
        alvosML     ? lerMarketplace("ML",     dateFrom, dateTo, skuTags, filtros, true) : Promise.resolve(),
        alvosShopee ? lerMarketplace("Shopee", dateFrom, dateTo, skuTags, filtros, true) : Promise.resolve(),
      ]);
      setUltimaSync(new Date().toLocaleTimeString("pt-BR"));
    } finally {
      setAtualizando(prev => ({
        ml:     alvosML     ? false : prev.ml,
        shopee: alvosShopee ? false : prev.shopee,
      }));
    }
  }

  function dispararSincronizar() {
    if (!ASYNC_SYNC_JOBS_ENABLED) {
      dispararSincronizarInline();
      return;
    }
    if (lojaAtiva === "todos" || lojaAtiva === "ML")     dispararUm("ML");
    if (lojaAtiva === "todos" || lojaAtiva === "Shopee") dispararUm("Shopee");
  }

  // Limpa polling pendente ao desmontar a página (evita setState após unmount).
  useEffect(() => {
    return () => {
      pararPolling("ML");
      pararPolling("Shopee");
    };
  }, []);

  // Leitura ao montar E toda vez que o período, marketplace ou date_field mudar
  // (NÃO dispara sync — só lê o cache atual; ver dispararSincronizar para o botão).
  useEffect(() => {
    refetchTudo(dateFrom, dateTo, skuTags, [...filtrosCadastro, ...filtrosStatus], lojaAtiva);
  }, [dateFrom, dateTo, lojaAtiva, dateField]); // eslint-disable-line

  const OPCOES_CADASTRO = [
    { key: "cadastrados",     label: "Cadastrados",     icone: "✅", cor: "#00D97E", bg: "rgba(0,217,126,0.12)" },
    { key: "nao_cadastrados", label: "Não cadastrados", icone: "⚠️", cor: "#ff6b00", bg: "rgba(255,106,0,0.12)" },
  ] as const;

  const OPCOES_STATUS = [
    { key: "validas",    label: "Válidas",     icone: "✅", cor: "#00D97E", bg: "rgba(0,217,126,0.12)"   },
    { key: "canceladas", label: "Canceladas",  icone: "❌", cor: "#ff4d4d", bg: "rgba(255,77,77,0.12)"   },
    { key: "devolucoes", label: "Devoluções",  icone: "🔄", cor: "#b07aff", bg: "rgba(176,122,255,0.12)" },
  ] as const;

  const OPCOES_ENVIO = [
    { key: "Full",   label: "Full",   icone: "⚡", cor: "#00D97E", bg: "rgba(0,217,126,0.12)"  },
    { key: "Flex",   label: "Flex",   icone: "🚴", cor: "#6fa3ff", bg: "rgba(111,163,255,0.12)" },
    { key: "Coleta", label: "Coleta", icone: "📦", cor: "#ffb800", bg: "rgba(255,184,0,0.12)"   },
  ] as const;

  function toggleFiltro(key: string) {
    setFiltrosCadastro(prev =>
      prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key]
    );
  }

  function toggleStatus(key: string) {
    setFiltrosStatus(prev => {
      const next = prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key];
      // Se mudou se há ou não canceladas/devoluções, rebusca na API
      const precisava = prev.includes("canceladas") || prev.includes("devolucoes");
      const precisa   = next.includes("canceladas") || next.includes("devolucoes");
      if (precisava !== precisa) {
        refetchTudo(dateFrom, dateTo, skuTags, [...filtrosCadastro, ...next]);
      }
      return next;
    });
  }

  // Filtra por loja (client-side)
  const rowsLoja = lojaAtiva === "todos" ? rows : rows.filter(r => r.marketplace === lojaAtiva);

  // Aplica filtros de cadastro + status (multi-select, combinados em OR)
  const filteredRowsBase = rowsLoja.filter(r => {
    const temFiltro = filtrosCadastro.length > 0 || filtrosStatus.length > 0;
    if (!temFiltro) return r.status === "paid" || r.status === "devolucao"; // padrão: pagas + devoluções (igual ao ML que conta ambas em "quantidade de vendas")

    const passCadastro = filtrosCadastro.some(f => {
      if (f === "cadastrados")     return r.status === "paid" && r.cadastrado;
      if (f === "nao_cadastrados") return r.status === "paid" && !r.cadastrado;
      return false;
    });
    const passStatus = filtrosStatus.some(f => {
      if (f === "validas")    return r.status === "paid";
      if (f === "canceladas") return r.status === "cancelled"; // só canceladas sem pagamento
      if (f === "devolucoes") return r.status === "devolucao";
      return false;
    });
    return passCadastro || passStatus;
  });

  // Não cadastrados: 1 linha por produto único
  const filteredRowsDedup = filtrosCadastro.includes("nao_cadastrados") && filtrosCadastro.length === 1 && filtrosStatus.length === 0
    ? filteredRowsBase.filter((r, _, arr) => arr.findIndex(x => x.mlItemId === r.mlItemId) === arr.indexOf(r))
    : filteredRowsBase;

  // Filtro de envio (client-side)
  const filteredRows = filtrosEnvio.length === 0
    ? filteredRowsDedup
    : filteredRowsDedup.filter(r => filtrosEnvio.includes(r.logistica));

  // Contagens para os dropdowns
  const paidRows = rowsLoja.filter(r => r.status === "paid");
  const countMap: Record<string, number> = {
    cadastrados:     paidRows.filter(r =>  r.cadastrado).length,
    nao_cadastrados: new Set(paidRows.filter(r => !r.cadastrado).map(r => r.mlItemId)).size,
  };
  const statusCountMap: Record<string, number> = {
    validas:    rowsLoja.filter(r => r.status === "paid").length,
    canceladas: rowsLoja.filter(r => r.status === "cancelled").length,
    devolucoes: rowsLoja.filter(r => r.status === "devolucao").length,
    aguardando: rowsLoja.filter(r => r.status === "pending").length,
  };

  // Contagens de envio (sobre todas as linhas filtradas por loja+cadastro, sem filtro envio)
  const envioCountMap: Record<string, number> = {
    Full:   filteredRowsDedup.filter(r => r.logistica === "Full").length,
    Flex:   filteredRowsDedup.filter(r => r.logistica === "Flex").length,
    Coleta: filteredRowsDedup.filter(r => r.logistica === "Coleta").length,
  };

  // Totais — calculado só sobre pedidos pagos (devoluções aparecem na tabela mas não entram no total)
  const totais = filteredRows
    .filter(r => r.status === "paid")
    .reduce(
      (acc, r) => ({
        faturamento:    acc.faturamento    + r.faturamento,
        custo:          acc.custo          + r.custo,
        imposto:        acc.imposto        + r.imposto,
        tarifaVenda:    acc.tarifaVenda    + r.tarifaVenda,
        freteComprador: acc.freteComprador + r.freteComprador,
        freteVendedor:  acc.freteVendedor  + r.freteVendedor,
        margemContrib:  acc.margemContrib  + r.margemContrib,
        qtd:            acc.qtd            + r.qtd,
      }),
      { faturamento: 0, custo: 0, imposto: 0, tarifaVenda: 0, freteComprador: 0, freteVendedor: 0, margemContrib: 0, qtd: 0 }
    );
  const mcTotalPct = totais.faturamento > 0 ? (totais.margemContrib / totais.faturamento) * 100 : 0;
  // Conta ordens únicas PAGAS (igual ao critério de totais.faturamento)
  // BUG 3 FIX: antes contava todos os status incluindo cancelados, divergindo da Shopee
  const pedidosUnicos = new Set(filteredRows.filter(r => r.status === "paid").map(r => r.orderId)).size;

  // ── Estilos reutilizáveis ────────────────────────────────────────────────
  const inputStyle: React.CSSProperties = {
    padding: "9px 13px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.05)",
    color: "white",
    fontSize: "13px",
    outline: "none",
  };

  const thStyle: React.CSSProperties = {
    padding: "10px 12px",
    textAlign: "left",
    fontSize: "10px",
    fontWeight: 800,
    color: "#9099aa",
    letterSpacing: "0.4px",
    whiteSpace: "nowrap",
    borderBottom: "1px solid rgba(255,255,255,0.07)",
    background: "#111318",
    position: "sticky",
    top: 0,
    zIndex: 2,
  };

  const tdStyle = (right = false): React.CSSProperties => ({
    padding: "11px 12px",
    fontSize: "12px",
    borderBottom: "1px solid rgba(255,255,255,0.04)",
    whiteSpace: "nowrap",
    textAlign: right ? "right" : "left",
    verticalAlign: "middle",
  });

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "32px 32px 64px", color: "white", minHeight: "100vh" }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "28px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "26px", fontWeight: 900, margin: 0 }}>Vendas</h1>
          <div style={{ color: "#9099aa", fontSize: "13px", marginTop: "4px" }}>
            {conta ? `● ${conta}` : "Mercado Livre"}{ultimaSync ? ` · Sincronizado às ${ultimaSync}` : ""}
          </div>
          {(syncMsg.ml || syncMsg.shopee) && (
            <div style={{ color: "#9099aa", fontSize: "11px", marginTop: "3px", fontStyle: "italic" }}>
              {[syncMsg.ml, syncMsg.shopee].filter(Boolean).join(" · ")}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button
            onClick={() => { setHistoricoOpen(true); if (!historicoRodando && historicoMeses.length === 0) iniciarHistorico(); }}
            style={{
              padding: "10px 16px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "12px",
              color: "#9099aa",
              fontWeight: 700,
              fontSize: "13px",
              cursor: "pointer",
              display: "flex", alignItems: "center", gap: "7px",
            }}
          >
            🗂 Histórico
          </button>
          <button
            onClick={dispararSincronizar}
            disabled={atualizando.ml || atualizando.shopee}
            style={{
              padding: "10px 20px",
              background: (atualizando.ml || atualizando.shopee) ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
              border: "none",
              borderRadius: "12px",
              color: (atualizando.ml || atualizando.shopee) ? "#9099aa" : "#10131b",
              fontWeight: 800,
              fontSize: "13px",
              cursor: (atualizando.ml || atualizando.shopee) ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: "7px",
            }}
          >
            {(atualizando.ml || atualizando.shopee) ? (
              <>
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>
                Atualizando...
              </>
            ) : "⟳ Sincronizar"}
          </button>
        </div>
      </div>

      {/* ── Filtros ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", gap: "10px", marginBottom: "24px", flexWrap: "wrap", alignItems: "flex-end",
        background: "#111318", border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "16px", padding: "16px 20px",
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>PERÍODO</label>
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); refetchTudo(f, t, skuTags, [...filtrosCadastro, ...filtrosStatus]); }}
          />
        </div>
        {/* Plataforma */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", position: "relative" }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>PLATAFORMA</label>
          <button
            onClick={() => setPlataformaOpen(v => !v)}
            style={{
              padding: "9px 14px",
              borderRadius: "10px",
              border: `1px solid ${lojaAtiva !== "todos" || plataformaOpen ? "rgba(255,107,0,0.4)" : "rgba(255,255,255,0.1)"}`,
              background: lojaAtiva !== "todos" || plataformaOpen ? "rgba(255,107,0,0.08)" : "rgba(255,255,255,0.05)",
              color: lojaAtiva !== "todos" ? "#ff6b00" : plataformaOpen ? "#ff6b00" : "#d7dbe5",
              fontWeight: 700,
              fontSize: "13px",
              cursor: "pointer",
              display: "flex", alignItems: "center", gap: "8px",
              whiteSpace: "nowrap",
            }}
          >
            {lojaAtiva === "todos"  && "🏪 Todas"}
            {lojaAtiva === "ML"     && "🛒 Mercado Livre"}
            {lojaAtiva === "Shopee" && "🟠 Shopee"}
            <span style={{ fontSize: "10px", opacity: 0.5 }}>▾</span>
          </button>

          {plataformaOpen && (
            <>
              <div onClick={() => setPlataformaOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
                background: "#111318", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "12px", padding: "6px", minWidth: "160px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                display: "flex", flexDirection: "column", gap: "2px",
              }}>
                {LOJAS.map(({ key, label, cor, bg }) => {
                  const ativo = lojaAtiva === key;
                  return (
                    <button
                      key={key}
                      onClick={() => { setLojaAtiva(key); setPlataformaOpen(false); }}
                      style={{
                        padding: "9px 12px",
                        borderRadius: "8px",
                        border: "none",
                        background: ativo ? bg : "transparent",
                        color: ativo ? cor : "#9099aa",
                        fontWeight: ativo ? 800 : 600,
                        fontSize: "13px",
                        cursor: "pointer",
                        textAlign: "left",
                        display: "flex", alignItems: "center", gap: "8px",
                      }}
                    >
                      {key === "todos"  && "🏪"}
                      {key === "ML"     && "🛒"}
                      {key === "Shopee" && "🟠"}
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Cadastro — multi-select */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", position: "relative" }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>CADASTRO</label>
          <button
            onClick={() => setCadastroOpen(v => !v)}
            style={{
              padding: "9px 14px", borderRadius: "10px",
              border: `1px solid ${filtrosCadastro.length > 0 || cadastroOpen ? "rgba(255,107,0,0.4)" : "rgba(255,255,255,0.1)"}`,
              background: filtrosCadastro.length > 0 || cadastroOpen ? "rgba(255,107,0,0.08)" : "rgba(255,255,255,0.05)",
              color: filtrosCadastro.length > 0 ? "#ff6b00" : cadastroOpen ? "#ff6b00" : "#d7dbe5",
              fontWeight: 700, fontSize: "13px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap",
            }}
          >
            📋 {filtrosCadastro.length === 0 ? "Todos" : filtrosCadastro.length === 1
              ? OPCOES_CADASTRO.find(o => o.key === filtrosCadastro[0])?.label
              : `${filtrosCadastro.length} filtros`}
            {filtrosCadastro.length > 0 && (
              <span style={{ background: "rgba(255,107,0,0.25)", color: "#ff6b00", fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px" }}>
                {filtrosCadastro.length}
              </span>
            )}
            <span style={{ fontSize: "10px", opacity: 0.5 }}>▾</span>
          </button>

          {cadastroOpen && (
            <>
              <div onClick={() => setCadastroOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
                background: "#111318", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "12px", padding: "8px", minWidth: "210px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                display: "flex", flexDirection: "column", gap: "2px",
              }}>
                {/* Limpar */}
                {filtrosCadastro.length > 0 && (
                  <button
                    onClick={() => { setFiltrosCadastro([]); refetchTudo(dateFrom, dateTo, skuTags, [...filtrosStatus]); }}
                    style={{ padding: "6px 12px", borderRadius: "8px", border: "none", background: "transparent", color: "#9099aa", fontSize: "11px", cursor: "pointer", textAlign: "left", marginBottom: "4px" }}
                  >
                    ✕ Limpar seleção
                  </button>
                )}
                {OPCOES_CADASTRO.map(({ key, label, icone, cor, bg }) => {
                  const ativo = filtrosCadastro.includes(key);
                  const count = countMap[key] ?? 0;
                  return (
                    <button
                      key={key}
                      onClick={() => toggleFiltro(key)}
                      style={{
                        padding: "9px 12px", borderRadius: "8px", border: "none",
                        background: ativo ? bg : "transparent",
                        color: ativo ? cor : "#9099aa",
                        fontWeight: ativo ? 800 : 600, fontSize: "13px",
                        cursor: "pointer", textAlign: "left",
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        {/* checkbox visual */}
                        <span style={{
                          width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0,
                          border: `2px solid ${ativo ? cor : "rgba(255,255,255,0.2)"}`,
                          background: ativo ? cor : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "10px", color: "#10131b",
                        }}>
                          {ativo && "✓"}
                        </span>
                        {icone} {label}
                      </span>
                      {count > 0 && (
                        <span style={{
                          background: ativo ? `${cor}33` : "rgba(255,255,255,0.07)",
                          color: ativo ? cor : "#9099aa",
                          fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px",
                        }}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Status — multi-select */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", position: "relative" }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>STATUS</label>
          <button
            onClick={() => setStatusOpen(v => !v)}
            style={{
              padding: "9px 14px", borderRadius: "10px",
              border: `1px solid ${filtrosStatus.length > 0 || statusOpen ? "rgba(176,122,255,0.4)" : "rgba(255,255,255,0.1)"}`,
              background: filtrosStatus.length > 0 || statusOpen ? "rgba(176,122,255,0.08)" : "rgba(255,255,255,0.05)",
              color: filtrosStatus.length > 0 ? "#b07aff" : statusOpen ? "#b07aff" : "#d7dbe5",
              fontWeight: 700, fontSize: "13px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap",
            }}
          >
            🏷️ {filtrosStatus.length === 0 ? "Todos" : filtrosStatus.length === 1
              ? OPCOES_STATUS.find(o => o.key === filtrosStatus[0])?.label
              : `${filtrosStatus.length} status`}
            {filtrosStatus.length > 0 && (
              <span style={{ background: "rgba(176,122,255,0.2)", color: "#b07aff", fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px" }}>
                {filtrosStatus.length}
              </span>
            )}
            <span style={{ fontSize: "10px", opacity: 0.5 }}>▾</span>
          </button>

          {statusOpen && (
            <>
              <div onClick={() => setStatusOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
                background: "#111318", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "12px", padding: "8px", minWidth: "190px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                display: "flex", flexDirection: "column", gap: "2px",
              }}>
                {filtrosStatus.length > 0 && (
                  <button
                    onClick={() => { setFiltrosStatus([]); refetchTudo(dateFrom, dateTo, skuTags, [...filtrosCadastro]); }}
                    style={{ padding: "6px 12px", borderRadius: "8px", border: "none", background: "transparent", color: "#9099aa", fontSize: "11px", cursor: "pointer", textAlign: "left", marginBottom: "4px" }}
                  >
                    ✕ Limpar seleção
                  </button>
                )}
                {OPCOES_STATUS.map(({ key, label, icone, cor, bg }) => {
                  const ativo = filtrosStatus.includes(key);
                  const count = statusCountMap[key] ?? 0;
                  return (
                    <button
                      key={key}
                      onClick={() => toggleStatus(key)}
                      style={{
                        padding: "9px 12px", borderRadius: "8px", border: "none",
                        background: ativo ? bg : "transparent",
                        color: ativo ? cor : "#9099aa",
                        fontWeight: ativo ? 800 : 600, fontSize: "13px",
                        cursor: "pointer", textAlign: "left",
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{
                          width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0,
                          border: `2px solid ${ativo ? cor : "rgba(255,255,255,0.2)"}`,
                          background: ativo ? cor : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "10px", color: "#10131b",
                        }}>
                          {ativo && "✓"}
                        </span>
                        {icone} {label}
                      </span>
                      {count > 0 && (
                        <span style={{
                          background: ativo ? `${cor}33` : "rgba(255,255,255,0.07)",
                          color: ativo ? cor : "#9099aa",
                          fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px",
                        }}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Envio — multi-select */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", position: "relative" }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>ENVIO</label>
          <button
            onClick={() => setEnvioOpen(v => !v)}
            style={{
              padding: "9px 14px", borderRadius: "10px",
              border: `1px solid ${filtrosEnvio.length > 0 || envioOpen ? "rgba(0,217,126,0.4)" : "rgba(255,255,255,0.1)"}`,
              background: filtrosEnvio.length > 0 || envioOpen ? "rgba(0,217,126,0.08)" : "rgba(255,255,255,0.05)",
              color: filtrosEnvio.length > 0 ? "#00D97E" : envioOpen ? "#00D97E" : "#d7dbe5",
              fontWeight: 700, fontSize: "13px", cursor: "pointer",
              display: "flex", alignItems: "center", gap: "8px", whiteSpace: "nowrap",
            }}
          >
            🚚 {filtrosEnvio.length === 0 ? "Todos" : filtrosEnvio.length === 1
              ? filtrosEnvio[0]
              : `${filtrosEnvio.length} tipos`}
            {filtrosEnvio.length > 0 && (
              <span style={{ background: "rgba(0,217,126,0.2)", color: "#00D97E", fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px" }}>
                {filtrosEnvio.length}
              </span>
            )}
            <span style={{ fontSize: "10px", opacity: 0.5 }}>▾</span>
          </button>

          {envioOpen && (
            <>
              <div onClick={() => setEnvioOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
              <div style={{
                position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100,
                background: "#111318", border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "12px", padding: "8px", minWidth: "180px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                display: "flex", flexDirection: "column", gap: "2px",
              }}>
                {filtrosEnvio.length > 0 && (
                  <button
                    onClick={() => setFiltrosEnvio([])}
                    style={{ padding: "6px 12px", borderRadius: "8px", border: "none", background: "transparent", color: "#9099aa", fontSize: "11px", cursor: "pointer", textAlign: "left", marginBottom: "4px" }}
                  >
                    ✕ Limpar seleção
                  </button>
                )}
                {OPCOES_ENVIO.map(({ key, label, icone, cor, bg }) => {
                  const ativo = filtrosEnvio.includes(key);
                  const count = envioCountMap[key] ?? 0;
                  return (
                    <button
                      key={key}
                      onClick={() => setFiltrosEnvio(prev => prev.includes(key) ? prev.filter(f => f !== key) : [...prev, key])}
                      style={{
                        padding: "9px 12px", borderRadius: "8px", border: "none",
                        background: ativo ? bg : "transparent",
                        color: ativo ? cor : "#9099aa",
                        fontWeight: ativo ? 800 : 600, fontSize: "13px",
                        cursor: "pointer", textAlign: "left",
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px",
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span style={{
                          width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0,
                          border: `2px solid ${ativo ? cor : "rgba(255,255,255,0.2)"}`,
                          background: ativo ? cor : "transparent",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: "10px", color: "#10131b",
                        }}>
                          {ativo && "✓"}
                        </span>
                        {icone} {label}
                      </span>
                      {count > 0 && (
                        <span style={{
                          background: ativo ? `${cor}33` : "rgba(255,255,255,0.07)",
                          color: ativo ? cor : "#9099aa",
                          fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "1px 7px",
                        }}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* SKU / Produto — multi-tag */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "240px", flex: 1 }}>
          <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px" }}>SKU / PRODUTO</label>
          <div style={{
            display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center",
            padding: "6px 10px",
            borderRadius: "10px",
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.05)",
            minHeight: "38px",
          }}>
            {skuTags.map(tag => (
              <span key={tag} style={{
                display: "inline-flex", alignItems: "center", gap: "5px",
                background: "rgba(255,106,0,0.15)", border: "1px solid rgba(255,106,0,0.3)",
                color: "#ff6b00", fontWeight: 700, fontSize: "12px",
                borderRadius: "6px", padding: "2px 8px",
              }}>
                {tag}
                <button
                  onClick={() => removeSkuTag(tag)}
                  style={{ background: "none", border: "none", color: "#ff6b00", cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: 0 }}
                >×</button>
              </span>
            ))}
            <input
              type="text"
              placeholder={skuTags.length === 0 ? "Ex: PTATT10 — Enter para adicionar" : "Adicionar outro..."}
              value={skuInput}
              onChange={e => setSkuInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addSkuTag(); }
                if (e.key === "Backspace" && !skuInput && skuTags.length > 0) {
                  setSkuTags(prev => prev.slice(0, -1));
                }
              }}
              style={{
                flex: 1, minWidth: "120px",
                background: "none", border: "none", outline: "none",
                color: "white", fontSize: "13px",
              }}
            />
          </div>
        </div>

        <button
          onClick={() => { addSkuTag(); refetchTudo(dateFrom, dateTo, skuInput.trim() ? [...skuTags, skuInput.trim().toUpperCase()] : skuTags, [...filtrosCadastro, ...filtrosStatus]); setSkuInput(""); }}
          disabled={loading}
          style={{
            padding: "9px 18px", borderRadius: "10px", alignSelf: "flex-end",
            background: "rgba(255,106,0,0.15)", border: "1px solid rgba(255,106,0,0.3)",
            color: "#ff6b00", fontWeight: 800, fontSize: "13px", cursor: "pointer",
          }}
        >
          Buscar
        </button>
        {(skuTags.length > 0 || skuInput || dateFrom !== hoje || dateTo !== hoje || lojaAtiva !== "todos" || filtrosCadastro.length > 0 || filtrosStatus.length > 0 || filtrosEnvio.length > 0) && (
          <button
            onClick={() => { const h = hoje; setDateFrom(h); setDateTo(h); setSkuTags([]); setSkuInput(""); setLojaAtiva("todos"); setFiltrosCadastro([]); setFiltrosStatus([]); setFiltrosEnvio([]); refetchTudo(h, h, [], []); }}
            style={{
              padding: "9px 14px", borderRadius: "10px", alignSelf: "flex-end",
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              color: "#9099aa", fontWeight: 700, fontSize: "12px", cursor: "pointer",
            }}
          >
            Limpar
          </button>
        )}
      </div>

      {/* ── Banner de onboarding ────────────────────────────────────────── */}
      {onboardingPendente && !loading && (
        <div style={{
          background: "linear-gradient(135deg,rgba(255,107,0,0.1),rgba(255,184,0,0.06))",
          border: "1px solid rgba(255,107,0,0.3)",
          borderRadius: "16px", padding: "20px 24px", marginBottom: "20px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
          flexWrap: "wrap",
        }}>
          <div>
            <p style={{ margin: 0, fontSize: "15px", fontWeight: 800, color: "#ffb800" }}>
              🚀 Configure seu histórico de vendas
            </p>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#9099aa", lineHeight: 1.5 }}>
              Sincronize os últimos 2 meses para ver dados completos. Feito isso, o sistema atualiza automaticamente todo dia.
            </p>
          </div>
          <button
            onClick={() => { setHistoricoOpen(true); if (!historicoRodando && historicoMeses.length === 0) iniciarHistorico(); }}
            style={{
              padding: "12px 22px", borderRadius: "12px",
              background: "linear-gradient(135deg,#ff6b00,#ffb800)",
              border: "none", color: "#10131b", fontWeight: 900,
              fontSize: "13px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            Sincronizar Histórico →
          </button>
        </div>
      )}

      {/* ── Cards de resumo ─────────────────────────────────────────────── */}
      {!loading && filteredRows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "12px", marginBottom: "24px" }}>
          {[
            { label: "Pedidos",       val: pedidosUnicos.toString(),         cor: "#fff" },
            { label: "Unidades",      val: totais.qtd.toString(),            cor: "#fff" },
            { label: "Faturamento",   val: moeda(totais.faturamento),        cor: "#fff" },
            { label: "Margem Contrib.", val: moeda(totais.margemContrib),    cor: totais.margemContrib >= 0 ? "#00D97E" : "#ff4d4d" },
            { label: "MC %",          val: pct(mcTotalPct),                  cor: mcTotalPct >= 0 ? "#00D97E" : "#ff4d4d" },
          ].map(({ label, val, cor }) => (
            <div key={label} style={{
              background: "#111318", border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: "14px", padding: "14px 16px",
            }}>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", marginBottom: "5px", letterSpacing: "0.3px" }}>{label.toUpperCase()}</div>
              <div style={{ fontSize: "18px", fontWeight: 900, color: cor }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Loading skeleton ────────────────────────────────────────────── */}
      {loading && (
        <div style={{
          background: "#111318", border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "20px", overflow: "hidden",
        }}>
          {/* barra de progresso no topo */}
          <div style={{ height: "3px", background: "rgba(255,255,255,0.05)", position: "relative", overflow: "hidden" }}>
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(90deg, transparent, #ff6b00, #ffb800, transparent)",
              animation: "shimmer 1.4s infinite linear",
              backgroundSize: "600px 100%",
            }} />
          </div>
          {/* label */}
          <div style={{ padding: "16px 20px 0", display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ display: "inline-block", animation: "spin 1s linear infinite", fontSize: "16px" }}>⟳</span>
            <span style={{ color: "#9099aa", fontSize: "13px", fontWeight: 600 }}>
            {lojaAtiva === "Shopee" ? "Buscando vendas na Shopee…" : lojaAtiva === "ML" ? "Buscando vendas no Mercado Livre…" : "Buscando vendas em todos os marketplaces…"}
          </span>
          </div>
          {/* skeleton rows */}
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "900px" }}>
            <tbody>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  {[220, 90, 70, 70, 60, 60, 80, 80, 70, 70, 70].map((w, j) => (
                    <td key={j} style={{ padding: "14px 12px" }}>
                      <div className="skeleton" style={{ height: "12px", width: `${w - (i % 3) * 10}px`, opacity: 1 - i * 0.08 }} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Estados: erro / sem conexão / vazio ─────────────────────────── */}
      {/* rows.length === 0 (aprovado 2026-07-11): se já havia dados na tela,
          uma falha dupla e temporária não deve trocar a tabela pela tela de
          "desconectado" — mesma regra de preservação aplicada a este estado. */}
      {semConexao && !loading && rows.length === 0 && (
        <div style={{
          textAlign: "center", padding: "60px 20px",
          background: "#111318", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "20px",
        }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔗</div>
          <div style={{ fontWeight: 800, fontSize: "18px", marginBottom: "6px" }}>Nenhuma conta conectada</div>
          <div style={{ color: "#9099aa", fontSize: "14px" }}>Vá em Configurações e conecte sua conta do Mercado Livre ou Shopee.</div>
        </div>
      )}

      {erro && !semConexao && !loading && (
        <div style={{
          background: "rgba(255,77,77,0.08)", border: "1px solid rgba(255,77,77,0.2)",
          borderRadius: "14px", padding: "16px 20px", color: "#ff4d4d", fontSize: "13px", fontWeight: 600,
        }}>
          ⚠️ {erro}
        </div>
      )}

      {/* Aviso de erro parcial da Shopee */}
      {erroShopee && !semConexao && !loading && lojaAtiva !== "ML" && (
        <div style={{
          background: "rgba(238,77,45,0.08)", border: "1px solid rgba(238,77,45,0.25)",
          borderRadius: "12px", padding: "12px 18px", marginBottom: "16px",
          color: "#EE4D2D", fontSize: "13px", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px",
        }}>
          🛍 {erroShopeeMsg ?? "Shopee não conectada ou com erro. Verifique em Configurações."}
        </div>
      )}

      {/* Aviso quando Shopee está conectada mas sem dados no cache histórico */}
      {shopeeSemDados && !erroShopee && !semConexao && !loading && lojaAtiva !== "ML" && (
        <div style={{
          background: "rgba(255,180,0,0.08)", border: "1px solid rgba(255,180,0,0.25)",
          borderRadius: "12px", padding: "12px 18px", marginBottom: "16px",
          color: "#FFB400", fontSize: "13px", fontWeight: 600, display: "flex", alignItems: "center", gap: "8px",
        }}>
          🛍 Sem dados Shopee no cache. Use o botão <strong style={{ marginLeft: "4px" }}>🗂 Histórico</strong> para sincronizar o período completo.
        </div>
      )}

      {!loading && !semConexao && !erro && filteredRows.length === 0 && (
        <div style={{
          textAlign: "center", padding: "60px 20px",
          background: "#111318", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "20px",
        }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>📭</div>
          <div style={{ fontWeight: 800, fontSize: "18px", marginBottom: "6px" }}>Nenhuma venda encontrada</div>
          <div style={{ color: "#9099aa", fontSize: "14px" }}>
            {lojaAtiva === "Shopee"
              ? "Tente outro período ou verifique se há pedidos na Shopee."
              : lojaAtiva === "ML"
              ? "Tente outro período ou verifique se há pedidos pagos no Mercado Livre."
              : "Tente outro período ou verifique suas conexões em Configurações."}
          </div>
        </div>
      )}

      {/* ── Tabela ──────────────────────────────────────────────────────── */}
      {!loading && filteredRows.length > 0 && (
        <div style={{
          background: "#111318",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "20px",
          overflow: "hidden",
        }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "1100px" }}>
              <thead>
                <tr>
                  {[
                    { label: "ANÚNCIO",           right: false },
                    { label: "CONTA",             right: false },
                    { label: "SKU",               right: false },
                    { label: "DATA",              right: false },
                    { label: "FRETE",             right: false },
                    { label: "ENVIO",             right: false },
                    { label: "VALOR UNIT.",       right: true  },
                    { label: "QTD.",              right: true  },
                    { label: "FATURAMENTO",        right: true  },
                    { label: "CUSTO (-)",         right: true  },
                    { label: "IMPOSTO (-)",       right: true  },
                    { label: "TARIFA VENDA (-)",  right: true  },
                    { label: "FRETE COMPRADOR (-)", right: true },
                    { label: "FRETE VENDEDOR (-)", right: true  },
                    { label: "MARGEM CONTRIB.",   right: true  },
                    { label: "MC %",              right: true  },
                  ].map(({ label, right }) => (
                    <th key={label} style={{ ...thStyle, textAlign: right ? "right" : "left" }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r, i) => (
                  <tr key={`${r.orderId}-${r.mlItemId}`} style={{ background: r.status === "devolucao" ? "rgba(176,122,255,0.05)" : i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                    {/* Anúncio */}
                    <td style={tdStyle()}>
                      <div style={{ maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 700 }}>
                        {r.anuncio}
                      </div>
                      {r.status === "devolucao" && (
                        <div style={{ fontSize: "10px", color: "#b07aff", marginTop: "2px", fontWeight: 700 }}>🔄 Devolução</div>
                      )}
                      {r.status === "pending" && (
                        <div style={{ fontSize: "10px", color: "#ffb800", marginTop: "2px", fontWeight: 700 }}>⏳ Aguardando pagamento</div>
                      )}
                      {!r.cadastrado && r.status !== "devolucao" && (
                        <div style={{ fontSize: "10px", color: "#ff6b00", marginTop: "2px" }}>⚠ não cadastrado</div>
                      )}
                    </td>
                    {/* Conta + Marketplace */}
                    <td style={tdStyle()}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <span style={{
                          fontSize: "10px", fontWeight: 800, padding: "1px 6px", borderRadius: "5px",
                          background: r.marketplace === "Shopee" ? "rgba(238,77,45,0.15)" : "rgba(255,230,0,0.12)",
                          color:      r.marketplace === "Shopee" ? "#EE4D2D" : "#FFE000",
                          border:     `1px solid ${r.marketplace === "Shopee" ? "rgba(238,77,45,0.3)" : "rgba(255,230,0,0.25)"}`,
                        }}>
                          {r.marketplace === "Shopee" ? "🛍" : "🛒"}
                        </span>
                        <span style={{ fontSize: "11px", color: "#9099aa", fontWeight: 600 }}>{r.conta}</span>
                      </div>
                    </td>
                    {/* SKU */}
                    <td style={tdStyle()}>
                      {r.sku
                        ? <span style={{ fontFamily: "monospace", fontSize: "12px", background: "rgba(255,255,255,0.06)", padding: "2px 7px", borderRadius: "6px" }}>{r.sku}</span>
                        : <span style={{ color: "#9099aa", fontSize: "11px" }}>—</span>
                      }
                    </td>
                    {/* Data */}
                    <td style={tdStyle()}>
                      <span style={{ color: "#9099aa", fontSize: "12px" }}>
                        {new Date(r.data + "T12:00:00").toLocaleDateString("pt-BR")}
                      </span>
                    </td>
                    {/* Frete */}
                    <td style={tdStyle()}>
                      {r.frete === "gratis"
                        ? <span style={{ fontSize: "11px", color: "#00D97E", fontWeight: 700, background: "rgba(0,217,126,0.1)", padding: "2px 8px", borderRadius: "6px" }}>🚚 Grátis</span>
                        : <span style={{ fontSize: "11px", color: "#9099aa", fontWeight: 600, background: "rgba(255,255,255,0.05)", padding: "2px 8px", borderRadius: "6px" }}>📦 Comprador</span>
                      }
                    </td>
                    {/* Envio (logística) */}
                    <td style={tdStyle()}>
                      {r.logistica === "Full"   && <span style={{ fontSize: "11px", color: "#00D97E", fontWeight: 800, background: "rgba(0,217,126,0.1)",   padding: "2px 9px", borderRadius: "6px" }}>Full</span>}
                      {r.logistica === "Flex"   && <span style={{ fontSize: "11px", color: "#6fa3ff", fontWeight: 800, background: "rgba(100,160,255,0.1)", padding: "2px 9px", borderRadius: "6px" }}>Flex</span>}
                      {r.logistica === "Coleta" && <span style={{ fontSize: "11px", color: "#ffb800", fontWeight: 800, background: "rgba(255,184,0,0.1)",   padding: "2px 9px", borderRadius: "6px" }}>Coleta</span>}
                      {r.logistica === "Shopee" && <span style={{ fontSize: "11px", color: "#EE4D2D", fontWeight: 800, background: "rgba(238,77,45,0.1)", padding: "2px 9px", borderRadius: "6px" }}>Shopee</span>}
                      {r.logistica !== "Full" && r.logistica !== "Flex" && r.logistica !== "Coleta" && r.logistica !== "Shopee" && (
                        <span style={{ fontSize: "11px", color: "#9099aa" }}>{r.logistica || "—"}</span>
                      )}
                    </td>
                    {/* Valor Unit. */}
                    <td style={{ ...tdStyle(true), fontWeight: 700 }}>{moeda(r.valorUnit)}</td>
                    {/* Qtd */}
                    <td style={{ ...tdStyle(true), fontWeight: 700 }}>{r.qtd}</td>
                    {/* Faturamento */}
                    <td style={{ ...tdStyle(true), fontWeight: 800 }}>{moeda(r.faturamento)}</td>
                    {/* Custo */}
                    <td style={{ ...tdStyle(true), color: r.custo > 0 ? "#ff6b6b" : "#9099aa" }}>
                      {r.custo > 0 ? `-${moeda(r.custo)}` : "—"}
                    </td>
                    {/* Imposto */}
                    <td style={{ ...tdStyle(true), color: r.imposto > 0 ? "#ff6b6b" : "#9099aa" }}>
                      {r.imposto > 0 ? `-${moeda(r.imposto)}` : "—"}
                    </td>
                    {/* Tarifa */}
                    <td style={{ ...tdStyle(true), color: "#ff6b6b" }}>-{moeda(r.tarifaVenda)}</td>
                    {/* Frete Comprador */}
                    <td style={{ ...tdStyle(true), color: r.freteComprador > 0 ? "#ff6b6b" : "#9099aa" }}>
                      {r.freteComprador > 0 ? `-${moeda(r.freteComprador)}` : "—"}
                    </td>
                    {/* Frete Vendedor */}
                    <td style={{ ...tdStyle(true), color: r.freteVendedor > 0 ? "#ff6b6b" : "#9099aa" }}>
                      {r.freteVendedor > 0 ? `-${moeda(r.freteVendedor)}` : "—"}
                    </td>
                    {/* Margem Contrib. */}
                    <td style={{ ...tdStyle(true), fontWeight: 800, color: r.margemContrib >= 0 ? "#00D97E" : "#ff4d4d" }}>
                      {moeda(r.margemContrib)}
                    </td>
                    {/* MC % */}
                    <td style={{ ...tdStyle(true), fontWeight: 800, color: r.mcPercent >= 0 ? "#00D97E" : "#ff4d4d" }}>
                      {pct(r.mcPercent)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Linha de totais */}
              <tfoot>
                <tr style={{ background: "rgba(255,106,0,0.06)", borderTop: "2px solid rgba(255,106,0,0.2)" }}>
                  <td colSpan={6} style={{ ...tdStyle(), fontWeight: 800, color: "#ff6b00", fontSize: "11px", letterSpacing: "0.3px" }}>
                    TOTAL — {filteredRows.length} linha{filteredRows.length !== 1 ? "s" : ""}
                  </td>
                  <td style={tdStyle(true)}></td>
                  <td style={{ ...tdStyle(true), fontWeight: 800 }}>{totais.qtd}</td>
                  <td style={{ ...tdStyle(true), fontWeight: 900 }}>{moeda(totais.faturamento)}</td>
                  <td style={{ ...tdStyle(true), fontWeight: 700, color: "#ff6b6b" }}>{totais.custo > 0 ? `-${moeda(totais.custo)}` : "—"}</td>
                  <td style={{ ...tdStyle(true), fontWeight: 700, color: "#ff6b6b" }}>{totais.imposto > 0 ? `-${moeda(totais.imposto)}` : "—"}</td>
                  <td style={{ ...tdStyle(true), fontWeight: 700, color: "#ff6b6b" }}>-{moeda(totais.tarifaVenda)}</td>
                  <td style={{ ...tdStyle(true), fontWeight: 700, color: totais.freteComprador > 0 ? "#ff6b6b" : "#9099aa" }}>
                    {totais.freteComprador > 0 ? `-${moeda(totais.freteComprador)}` : "—"}
                  </td>
                  <td style={{ ...tdStyle(true), fontWeight: 700, color: totais.freteVendedor > 0 ? "#ff6b6b" : "#9099aa" }}>
                    {totais.freteVendedor > 0 ? `-${moeda(totais.freteVendedor)}` : "—"}
                  </td>
                  <td style={{ ...tdStyle(true), fontWeight: 900, color: totais.margemContrib >= 0 ? "#00D97E" : "#ff4d4d" }}>
                    {moeda(totais.margemContrib)}
                  </td>
                  <td style={{ ...tdStyle(true), fontWeight: 900, color: mcTotalPct >= 0 ? "#00D97E" : "#ff4d4d" }}>
                    {pct(mcTotalPct)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── Modal Sync Rápido ──────────────────────────────────────────────── */}
      {historicoOpen && (
        <>
          {/* Overlay */}
          <div
            onClick={() => { if (!quickSyncRodando) setHistoricoOpen(false); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200, backdropFilter: "blur(4px)" }}
          />

          {/* Modal */}
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 201,
            background: "#111318",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "20px",
            padding: "32px",
            width: "min(480px, 95vw)",
            maxHeight: "85vh",
            overflowY: "auto",
            boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          }}>

            {/* Cabeçalho */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: "20px", fontWeight: 900 }}>🔄 Sincronizar Período</h2>
                <p style={{ margin: "4px 0 0", color: "#9099aa", fontSize: "13px" }}>
                  Selecione o período — os dados são importados e exibidos automaticamente.
                </p>
              </div>
              {!quickSyncRodando && (
                <button
                  onClick={() => { setHistoricoOpen(false); setQuickSyncDias([]); }}
                  style={{ background: "none", border: "none", color: "#9099aa", fontSize: "20px", cursor: "pointer", padding: "4px 8px" }}
                >✕</button>
              )}
            </div>

            {quickSyncDias.length > 0 ? (
              /* ── Progresso dia-a-dia ── */
              (() => {
                const done  = quickSyncDias.filter(d => d.status === "ok" || d.status === "erro").length;
                const total = quickSyncDias.length;
                const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
                const erros = quickSyncDias.filter(d => d.status === "erro").length;
                const allDone = !quickSyncRodando && done === total;
                const totalPedidos = quickSyncDias.reduce((s, d) => s + (d.count ?? 0), 0);
                return (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#9099aa", marginBottom: "8px" }}>
                      <span>
                        {quickSyncRodando ? `Sincronizando ${quickSyncPreset}…`
                          : allDone && erros === 0 ? `✅ ${quickSyncPreset} — ${totalPedidos} pedidos importados`
                          : `⚠️ ${erros} dia(s) com erro`}
                      </span>
                      <span>{done}/{total} dias</span>
                    </div>
                    <div style={{ height: "6px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", overflow: "hidden", marginBottom: "16px" }}>
                      <div style={{
                        height: "100%", width: `${pct}%`,
                        background: erros > 0 ? "linear-gradient(90deg,#ff4d4d,#ffb800)" : "linear-gradient(90deg,#ff6b00,#ffb800)",
                        borderRadius: "3px", transition: "width 0.4s ease",
                      }} />
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "3px", maxHeight: "280px", overflowY: "auto" }}>
                      {quickSyncDias.map((d, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "center", justifyContent: "space-between",
                          padding: "8px 12px", borderRadius: "8px",
                          background: d.status === "sincronizando" ? "rgba(255,107,0,0.1)"
                            : d.status === "ok"   ? "rgba(0,217,126,0.06)"
                            : d.status === "erro" ? "rgba(255,77,77,0.08)"
                            : "rgba(255,255,255,0.03)",
                        }}>
                          <span style={{
                            fontSize: "13px", fontWeight: 600,
                            color: d.status === "sincronizando" ? "#ff6b00"
                              : d.status === "ok"   ? "#00D97E"
                              : d.status === "erro" ? "#ff4d4d"
                              : "#9099aa",
                          }}>
                            {d.status === "sincronizando" && <span style={{ display: "inline-block", animation: "spin 1s linear infinite", marginRight: "6px" }}>⟳</span>}
                            {d.status === "ok"       && "✅ "}
                            {d.status === "erro"     && "❌ "}
                            {d.status === "pendente" && "○ "}
                            {d.label}
                          </span>
                          <span style={{ fontSize: "11px", color: "#9099aa" }}>
                            {d.status === "ok"   && d.count !== undefined && `${d.count} pedidos`}
                            {d.status === "erro" && d.erro && d.erro.slice(0, 45)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div style={{ marginTop: "20px", display: "flex", gap: "8px" }}>
                      {quickSyncRodando ? (
                        <button
                          onClick={() => { cancelRef.current = true; }}
                          style={{
                            flex: 1, padding: "12px", borderRadius: "12px",
                            background: "rgba(255,77,77,0.1)", border: "1px solid rgba(255,77,77,0.3)",
                            color: "#ff4d4d", fontWeight: 700, fontSize: "14px", cursor: "pointer",
                          }}
                        >⏹ Cancelar</button>
                      ) : (
                        <>
                          <button
                            onClick={() => setQuickSyncDias([])}
                            style={{
                              flex: 1, padding: "12px", borderRadius: "12px",
                              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
                              color: "#9099aa", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                            }}
                          >← Voltar</button>
                          <button
                            onClick={() => {
                              if (quickSyncFrom && quickSyncTo) {
                                setDateFrom(quickSyncFrom);
                                setDateTo(quickSyncTo);
                                refetchTudo(quickSyncFrom, quickSyncTo, skuTags, [...filtrosCadastro, ...filtrosStatus]);
                              }
                              setHistoricoOpen(false);
                              setQuickSyncDias([]);
                            }}
                            style={{
                              flex: 2, padding: "12px", borderRadius: "12px",
                              background: "linear-gradient(135deg,#ff6b00,#ffb800)",
                              border: "none", color: "#10131b", fontWeight: 900, fontSize: "14px", cursor: "pointer",
                            }}
                          >📊 Ver resultados →</button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })()
            ) : (
              /* ── Seleção de preset ── */
              /* Presets (aprovado 2026-07-10): Hoje/Ontem/Últimos 7 dias/
                 Últimos 30 dias vêm de lib/date-range-utils.ts (mesma fonte
                 usada pelo Dashboard, Vendas e DateRangePicker) — nenhuma
                 lógica de data local aqui. "Personalizado" abre 2 campos de
                 data (sem cálculo, só o que o usuário escolher). Removido
                 "Este mês", que não faz parte da regra aprovada. */
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {DATE_PRESETS.map(p => {
                  const emoji = p.label === "Hoje" ? "🔵" : p.label === "Ontem" ? "📅" : p.label === "Últimos 7 dias" ? "📆" : "🗓";
                  const desc  = p.label === "Hoje" ? "Sincroniza o dia de hoje"
                    : p.label === "Ontem" ? "Sincroniza 1 dia"
                    : p.label === "Últimos 7 dias" ? "Sincroniza dia a dia (7 requests)"
                    : "Sincroniza dia a dia (30 requests)";
                  return (
                    <button
                      key={p.label}
                      onClick={() => { const r = p.get(); iniciarSyncRapido(r.from, r.to, p.label); }}
                      style={{
                        display: "flex", alignItems: "center", gap: "14px",
                        padding: "16px 20px", borderRadius: "14px",
                        background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
                        color: "#fff", fontWeight: 700, fontSize: "15px", cursor: "pointer", textAlign: "left",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,107,0,0.1)"; e.currentTarget.style.borderColor = "rgba(255,107,0,0.3)"; }}
                      onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
                    >
                      <span style={{ fontSize: "22px" }}>{emoji}</span>
                      <div>
                        <div>{p.label}</div>
                        <div style={{ fontSize: "12px", color: "#9099aa", fontWeight: 500, marginTop: "2px" }}>{desc}</div>
                      </div>
                      <span style={{ marginLeft: "auto", color: "#ff6b00", fontSize: "18px" }}>→</span>
                    </button>
                  );
                })}

                {/* Personalizado */}
                <button
                  onClick={() => setPersonalizadoAberto(v => !v)}
                  style={{
                    display: "flex", alignItems: "center", gap: "14px",
                    padding: "16px 20px", borderRadius: "14px",
                    background: personalizadoAberto ? "rgba(255,107,0,0.1)" : "rgba(255,255,255,0.04)",
                    border: personalizadoAberto ? "1px solid rgba(255,107,0,0.3)" : "1px solid rgba(255,255,255,0.1)",
                    color: "#fff", fontWeight: 700, fontSize: "15px", cursor: "pointer", textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: "22px" }}>🗂️</span>
                  <div>
                    <div>Personalizado</div>
                    <div style={{ fontSize: "12px", color: "#9099aa", fontWeight: 500, marginTop: "2px" }}>Escolher data inicial e final</div>
                  </div>
                  <span style={{ marginLeft: "auto", color: "#ff6b00", fontSize: "18px" }}>{personalizadoAberto ? "▲" : "→"}</span>
                </button>

                {personalizadoAberto && (
                  <div style={{ padding: "14px 16px", borderRadius: "14px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <div style={{ display: "flex", gap: "10px", marginBottom: "10px" }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: "11px", color: "#9099aa", display: "block", marginBottom: "4px" }}>De</label>
                        <input
                          type="date"
                          value={personalizadoFrom}
                          onChange={e => setPersonalizadoFrom(e.target.value)}
                          style={{ width: "100%", padding: "8px", borderRadius: "8px", background: "#0c0e13", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: "13px" }}
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: "11px", color: "#9099aa", display: "block", marginBottom: "4px" }}>Até</label>
                        <input
                          type="date"
                          value={personalizadoTo}
                          min={personalizadoFrom || undefined}
                          onChange={e => setPersonalizadoTo(e.target.value)}
                          style={{ width: "100%", padding: "8px", borderRadius: "8px", background: "#0c0e13", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: "13px" }}
                        />
                      </div>
                    </div>
                    {/* Garante início <= fim (aprovado 2026-07-10): min no campo "Até" já
                        impede escolher visualmente uma data anterior a "De"; a checagem
                        abaixo é a barreira real antes de disparar a sincronização. */}
                    <button
                      disabled={!personalizadoFrom || !personalizadoTo || personalizadoTo < personalizadoFrom}
                      onClick={() => iniciarSyncRapido(personalizadoFrom, personalizadoTo, "Personalizado")}
                      style={{
                        width: "100%", padding: "10px", borderRadius: "10px", border: "none",
                        background: (!personalizadoFrom || !personalizadoTo || personalizadoTo < personalizadoFrom)
                          ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
                        color: (!personalizadoFrom || !personalizadoTo || personalizadoTo < personalizadoFrom) ? "#666" : "#10131b",
                        fontWeight: 800, fontSize: "13px",
                        cursor: (!personalizadoFrom || !personalizadoTo || personalizadoTo < personalizadoFrom) ? "default" : "pointer",
                      }}
                    >Sincronizar período escolhido</button>
                  </div>
                )}
              </div>
            )}

          </div>
        </>
      )}
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
        input[type="month"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
      `}</style>
    </div>
  );
}
