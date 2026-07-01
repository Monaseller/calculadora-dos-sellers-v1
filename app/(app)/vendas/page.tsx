"use client";
import { useEffect, useState, useCallback } from "react";
import DateRangePicker from "./DateRangePicker";

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

function hojeISO() {
  const now = new Date();
  const brasilia = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brasilia.toISOString().split("T")[0];
}
function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toISO(d: Date) {
  return d.toISOString().split("T")[0];
}

// ── Componente ─────────────────────────────────────────────────────────────
export default function VendasPage() {
  const hoje = hojeISO();

  // Padrão: Últimos 7 dias (igual ao painel ML)
  const seteDiasAtras = (() => { const d = new Date(parseISO(hoje)); d.setDate(d.getDate() - 7); return toISO(d); })(); // ML: hoje + 7 anteriores
  const [dateFrom,  setDateFrom]  = useState(seteDiasAtras);
  const [dateTo,    setDateTo]    = useState(hoje);
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
  const [rows,      setRows]      = useState<VendaRow[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [erro,      setErro]      = useState<string | null>(null);
  const [semConexao, setSemConexao] = useState(false);
  const [totalPedidos, setTotalPedidos] = useState(0);
  const [conta,      setConta]    = useState("");
  const [ultimaSync, setUltimaSync] = useState<string | null>(null);

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

  const sync = useCallback(async (from: string, to: string, tags: string[], filtros: string[] = [], loja: "todos" | "ML" | "Shopee" = "todos") => {
    setLoading(true);
    setErro(null);

    try {
      const params = new URLSearchParams({ date_from: from, date_to: to });
      if (tags.length > 0) params.set("sku", tags.join(","));
      const needsCancelled = filtros.includes("canceladas") || filtros.includes("devolucoes");
      if (needsCancelled) params.set("include_cancelled", "true");

      const fetchML     = loja === "todos" || loja === "ML";
      const fetchShopee = loja === "todos" || loja === "Shopee";

      const [mlData, shopeeData] = await Promise.all([
        fetchML     ? fetch(`/api/ml/vendas?${params}`).then(r => r.json()).catch(() => null) : null,
        fetchShopee ? fetch(`/api/shopee/vendas?${params}`).then(r => r.json()).catch(() => null) : null,
      ]);

      const mlRows     = (!mlData?.erro     ? mlData?.rows     ?? [] : []) as VendaRow[];
      const shopeeRows = (!shopeeData?.erro ? shopeeData?.rows ?? [] : []) as VendaRow[];
      const allRows    = [...mlRows, ...shopeeRows].sort((a, b) => b.data.localeCompare(a.data));

      if (mlData?.erro && shopeeData?.erro) {
        setSemConexao(true); setRows([]);
      } else {
        setSemConexao(false);
        setRows(allRows);
        setTotalPedidos((mlData?.totalPedidos ?? 0) + (shopeeData?.totalPedidos ?? 0));
        const contas = [mlData?.conta, shopeeData?.conta].filter(Boolean);
        setConta(contas.join(" + ") || "");
        setUltimaSync(new Date().toLocaleTimeString("pt-BR"));
      }
    } catch {
      setErro("Falha na conexão.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-sync ao montar E toda vez que o período ou marketplace mudar
  useEffect(() => {
    sync(dateFrom, dateTo, skuTags, [...filtrosCadastro, ...filtrosStatus], lojaAtiva);
  }, [dateFrom, dateTo, lojaAtiva]); // eslint-disable-line

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
        sync(dateFrom, dateTo, skuTags, [...filtrosCadastro, ...next]);
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

  // Totais
  const totais = filteredRows.reduce(
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
  // Conta ordens únicas (ML conta "quantidade de vendas" = ordens, não itens de linha)
  const pedidosUnicos = new Set(filteredRows.map(r => r.orderId)).size;

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
        </div>

        <button
          onClick={() => sync(dateFrom, dateTo, skuTags, [...filtrosCadastro, ...filtrosStatus])}
          disabled={loading}
          style={{
            padding: "10px 20px",
            background: loading ? "rgba(255,255,255,0.06)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
            border: "none",
            borderRadius: "12px",
            color: loading ? "#9099aa" : "#10131b",
            fontWeight: 800,
            fontSize: "13px",
            cursor: loading ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "7px",
          }}
        >
          {loading ? (
            <>
              <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>
              Sincronizando...
            </>
          ) : "⟳ Sincronizar Vendas"}
        </button>
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
            onChange={(f, t) => { setDateFrom(f); setDateTo(t); sync(f, t, skuTags, [...filtrosCadastro, ...filtrosStatus]); }}
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
                    onClick={() => { setFiltrosCadastro([]); sync(dateFrom, dateTo, skuTags, [...filtrosStatus]); }}
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
                    onClick={() => { setFiltrosStatus([]); sync(dateFrom, dateTo, skuTags, [...filtrosCadastro]); }}
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
          onClick={() => { addSkuTag(); sync(dateFrom, dateTo, skuInput.trim() ? [...skuTags, skuInput.trim().toUpperCase()] : skuTags, [...filtrosCadastro, ...filtrosStatus]); setSkuInput(""); }}
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
            onClick={() => { const h = hoje; setDateFrom(h); setDateTo(h); setSkuTags([]); setSkuInput(""); setLojaAtiva("todos"); setFiltrosCadastro([]); setFiltrosStatus([]); setFiltrosEnvio([]); sync(h, h, [], []); }}
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
      {semConexao && !loading && (
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

      {!loading && !semConexao && !erro && filteredRows.length === 0 && (
        <div style={{
          textAlign: "center", padding: "60px 20px",
          background: "#111318", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "20px",
        }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>📭</div>
          <div style={{ fontWeight: 800, fontSize: "18px", marginBottom: "6px" }}>Nenhuma venda encontrada</div>
          <div style={{ color: "#9099aa", fontSize: "14px" }}>Tente outro período ou verifique se há pedidos pagos no ML.</div>
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
                    { label: "FATURAMENTO ML",    right: true  },
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

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); cursor: pointer; }
      `}</style>
    </div>
  );
}
