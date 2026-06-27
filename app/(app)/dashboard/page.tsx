"use client";
import { useEffect, useState, useCallback } from "react";
import DateRangePicker from "../vendas/DateRangePicker";

// ── Tipos ──────────────────────────────────────────────────────────────────
type VendaRow = {
  orderId: string;
  data: string;
  anuncio: string;
  status: string;
  mlItemId: string;
  sku: string | null;
  qtd: number;
  valorUnit: number;
  faturamento: number;
  custo: number;
  tarifaVenda: number;
  freteComprador: number;
  freteVendedor: number;
  margemContrib: number;
  mcPercent: number;
};

type KPIs = {
  faturamento: number;
  pedidos: number;
  ticket: number;
  lucro: number;
  margem: number;
  unidades: number;
};

type TopAnuncio = {
  mlItemId: string;
  nome: string;
  sku: string | null;
  faturamento: number;
  lucro: number;
  qtd: number;
  margem: number;
};

type DiaData = { data: string; label: string; faturamento: number; lucro: number };

// ── Helpers ────────────────────────────────────────────────────────────────
function hojeISO() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().split("T")[0];
}

function seteDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function fmtBRL(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtData(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

// ── Gráfico SVG ───────────────────────────────────────────────────────────
function BarChart({ dias }: { dias: DiaData[] }) {
  if (!dias.length) return null;
  const maxFat = Math.max(...dias.map(d => d.faturamento), 1);

  return (
    <div style={{ width: "100%", overflowX: "auto" }}>
      <div style={{
        minWidth: dias.length > 10 ? `${dias.length * 48}px` : "100%",
        height: "180px", display: "flex", alignItems: "flex-end", gap: "4px", padding: "0 4px",
      }}>
        {dias.map((d, i) => {
          const h = Math.max((d.faturamento / maxFat) * 140, d.faturamento > 0 ? 4 : 0);
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
              <div
                title={`${d.label}: ${fmtBRL(d.faturamento)}`}
                style={{
                  width: "100%", height: `${h}px`,
                  background: "linear-gradient(180deg, #FFB600 0%, #FF6B00 100%)",
                  borderRadius: "4px 4px 0 0",
                  transition: "height 0.3s ease",
                  cursor: "default",
                  minHeight: d.faturamento > 0 ? "4px" : "0",
                }}
              />
              <span style={{ fontSize: "10px", color: "#9099aa", whiteSpace: "nowrap" }}>{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Card KPI ──────────────────────────────────────────────────────────────
function KpiCard({ label, valor, sub, cor = "#fff" }: {
  label: string; valor: string; sub?: string; cor?: string;
}) {
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.08)",
      borderRadius: "14px", padding: "20px 22px",
    }}>
      <div style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "10px" }}>
        {label}
      </div>
      <div style={{ fontSize: "26px", fontWeight: 900, color: cor, letterSpacing: "-0.5px" }}>
        {valor}
      </div>
      {sub && <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "4px" }}>{sub}</div>}
    </div>
  );
}

// ── Página ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const hoje = hojeISO();
  const [dateFrom, setDateFrom] = useState(seteDiasAtras());
  const [dateTo,   setDateTo]   = useState(hoje);
  const [kpis,     setKpis]     = useState<KPIs | null>(null);
  const [dias,     setDias]     = useState<DiaData[]>([]);
  const [tops,     setTops]     = useState<TopAnuncio[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [erro,     setErro]     = useState<string | null>(null);

  const carregar = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setErro(null);
    try {
      const res  = await fetch(`/api/ml/vendas?date_from=${from}&date_to=${to}`);
      const data = await res.json();

      if (data.erro) {
        setErro(data.mensagem || "Erro ao carregar dados.");
        setLoading(false);
        return;
      }

      const rows: VendaRow[] = (data.rows ?? []).filter((r: VendaRow) => r.status === "paid");

      // ── KPIs ──────────────────────────────────────────────────────────
      const faturamento = rows.reduce((s, r) => s + r.faturamento, 0);
      const lucro       = rows.reduce((s, r) => s + r.margemContrib, 0);
      const unidades    = rows.reduce((s, r) => s + r.qtd, 0);
      const pedidos     = new Set(rows.map(r => r.orderId)).size;
      const ticket      = pedidos > 0 ? faturamento / pedidos : 0;
      const margem      = faturamento > 0 ? (lucro / faturamento) * 100 : 0;
      setKpis({ faturamento, pedidos, ticket, lucro, margem, unidades });

      // ── Gráfico por dia ───────────────────────────────────────────────
      const mapaData = new Map<string, { faturamento: number; lucro: number }>();
      let cur = from;
      while (cur <= to) {
        mapaData.set(cur, { faturamento: 0, lucro: 0 });
        cur = addDays(cur, 1);
      }
      for (const r of rows) {
        const d = mapaData.get(r.data);
        if (d) { d.faturamento += r.faturamento; d.lucro += r.margemContrib; }
      }
      setDias(
        Array.from(mapaData.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([data, v]) => ({ data, label: fmtData(data), ...v }))
      );

      // ── Top anúncios ──────────────────────────────────────────────────
      const mapaAnu = new Map<string, TopAnuncio>();
      for (const r of rows) {
        const key = r.mlItemId || r.anuncio;
        const ex  = mapaAnu.get(key);
        if (ex) {
          ex.faturamento += r.faturamento;
          ex.lucro       += r.margemContrib;
          ex.qtd         += r.qtd;
        } else {
          mapaAnu.set(key, { mlItemId: r.mlItemId, nome: r.anuncio, sku: r.sku, faturamento: r.faturamento, lucro: r.margemContrib, qtd: r.qtd, margem: 0 });
        }
      }
      setTops(
        Array.from(mapaAnu.values())
          .map(a => ({ ...a, margem: a.faturamento > 0 ? (a.lucro / a.faturamento) * 100 : 0 }))
          .sort((a, b) => b.faturamento - a.faturamento)
          .slice(0, 8)
      );
    } catch {
      setErro("Erro de conexão.");
    }
    setLoading(false);
  }, []);

  useEffect(() => { carregar(dateFrom, dateTo); }, [dateFrom, dateTo, carregar]);

  return (
    <div style={{ padding: "32px", maxWidth: "1100px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "28px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "22px", fontWeight: 900, color: "#fff", margin: 0 }}>Dashboard</h1>
          <p style={{ fontSize: "13px", color: "#9099aa", marginTop: "4px" }}>
            Visão geral das suas vendas
          </p>
        </div>
        <DateRangePicker
          from={dateFrom}
          to={dateTo}
          onChange={(f, t) => { setDateFrom(f); setDateTo(t); }}
        />
      </div>

      {/* Erro */}
      {erro && (
        <div style={{
          background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.2)",
          borderRadius: "12px", padding: "16px 20px", color: "#ff7777",
          fontSize: "14px", marginBottom: "24px",
        }}>
          {erro.includes("não conectada") || erro.includes("expirada")
            ? "⚠️ Conecte sua conta do Mercado Livre em Configurações para ver os dados."
            : `⚠️ ${erro}`}
        </div>
      )}

      {/* Skeleton loading */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "14px" }}>
            {[...Array(5)].map((_, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "14px", padding: "20px 22px", height: "88px" }}>
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: "4px", height: "10px", width: "60%", marginBottom: "12px" }} />
                <div style={{ background: "rgba(255,255,255,0.08)", borderRadius: "4px", height: "26px", width: "80%" }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Conteúdo */}
      {!loading && !erro && kpis && (
        <>
          {/* KPI Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "14px", marginBottom: "24px" }}>
            <KpiCard label="Faturamento"   valor={fmtBRL(kpis.faturamento)} sub={`${kpis.unidades} unid.`} cor="#FFB600" />
            <KpiCard label="Pedidos"       valor={String(kpis.pedidos)}     sub="pagos" />
            <KpiCard label="Ticket Médio"  valor={fmtBRL(kpis.ticket)}      sub="por pedido" />
            <KpiCard label="Lucro Líquido" valor={fmtBRL(kpis.lucro)}       cor={kpis.lucro >= 0 ? "#00D97E" : "#ff6b6b"} sub="após custos" />
            <KpiCard
              label="Margem"
              valor={`${kpis.margem.toFixed(1)}%`}
              cor={kpis.margem >= 20 ? "#00D97E" : kpis.margem >= 10 ? "#FFB600" : "#ff6b6b"}
              sub="contribuição"
            />
          </div>

          {/* Gráfico */}
          {dias.length > 1 && (
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "16px", padding: "24px", marginBottom: "24px",
            }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#9099aa", marginBottom: "18px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Faturamento por dia
              </div>
              <BarChart dias={dias} />
            </div>
          )}

          {/* Top Anúncios */}
          {tops.length > 0 && (
            <div style={{
              background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "16px", padding: "24px",
            }}>
              <div style={{ fontSize: "13px", fontWeight: 700, color: "#9099aa", marginBottom: "18px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Top anúncios
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {tops.map((a, i) => (
                  <div key={a.mlItemId || i} style={{
                    display: "grid",
                    gridTemplateColumns: "24px 1fr 110px 80px 70px 80px",
                    alignItems: "center", gap: "12px", padding: "12px 14px",
                    borderRadius: "10px",
                    background: i % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent",
                  }}>
                    <span style={{ fontSize: "13px", fontWeight: 800, color: i < 3 ? "#FFB600" : "#9099aa" }}>{i + 1}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "13px", fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.nome}
                      </div>
                      {a.sku && <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "2px" }}>SKU: {a.sku}</div>}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#FFB600" }}>{fmtBRL(a.faturamento)}</div>
                      <div style={{ fontSize: "11px", color: "#9099aa" }}>faturamento</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: a.lucro >= 0 ? "#00D97E" : "#ff6b6b" }}>{fmtBRL(a.lucro)}</div>
                      <div style={{ fontSize: "11px", color: "#9099aa" }}>lucro</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: a.margem >= 20 ? "#00D97E" : a.margem >= 10 ? "#FFB600" : "#ff6b6b" }}>
                        {a.margem.toFixed(1)}%
                      </div>
                      <div style={{ fontSize: "11px", color: "#9099aa" }}>margem</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: "13px", fontWeight: 700, color: "#fff" }}>{a.qtd}</div>
                      <div style={{ fontSize: "11px", color: "#9099aa" }}>unid.</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Estado vazio */}
          {kpis.pedidos === 0 && (
            <div style={{
              background: "rgba(255,255,255,0.02)", border: "1px dashed rgba(255,255,255,0.1)",
              borderRadius: "16px", padding: "60px", textAlign: "center",
            }}>
              <div style={{ fontSize: "40px", marginBottom: "14px" }}>📦</div>
              <div style={{ fontWeight: 700, fontSize: "15px", color: "#fff", marginBottom: "6px" }}>Nenhuma venda no período</div>
              <div style={{ fontSize: "13px", color: "#9099aa" }}>
                Os dados aparecem aqui assim que houver pedidos pagos no Mercado Livre.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
