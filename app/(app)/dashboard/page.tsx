"use client";
import React, { useEffect, useState, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import DateRangePicker from "../vendas/DateRangePicker";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type VendaRow = {
  orderId: string; data: string; anuncio: string; status: string;
  mlItemId: string; sku: string | null; qtd: number;
  faturamento: number; custo: number; tarifaVenda: number;
  freteComprador: number; freteVendedor: number;
  margemContrib: number; mcPercent: number;
};
type Anuncio = {
  ml_item_id: string | null; thumbnail: string | null;
  nome: string; sku: string | null; marketplace: string;
  custo_produto: number | null; preco_anuncio: number | null;
  margem_contribuicao: number | null;
};
type Loja = {
  id: string; nome: string; marketplace: string; nickname: string | null; ativo: boolean;
};
type DiaData = {
  data: string; label: string; faturamento: number; lucro: number;
  custo: number; comissao: number; frete: number;
};
type TopProduto = {
  mlItemId: string; nome: string; sku: string | null;
  thumbnail: string | null; faturamento: number; lucro: number;
  margem: number; qtd: number;
};

function hojeISO() {
  const now = new Date();
  return new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString().split("T")[0];
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}
function saudacao() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}
function fmtBRL(v: number, compact = false) {
  if (compact && Math.abs(v) >= 1000) return `R$ ${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtData(iso: string) {
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function smoothPath(data: number[], W: number, H: number): string {
  if (data.length < 2) return "";
  const max = Math.max(...data, 0.01);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * W,
    y: H - ((v - min) / range) * H * 0.8 - H * 0.1,
  }));
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const cx1 = pts[i - 1].x + (pts[i].x - pts[i - 1].x) / 3;
    const cx2 = pts[i].x - (pts[i].x - pts[i - 1].x) / 3;
    d += ` C ${cx1.toFixed(1)} ${pts[i - 1].y.toFixed(1)}, ${cx2.toFixed(1)} ${pts[i].y.toFixed(1)}, ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  return d;
}
function areaPath(data: number[], W: number, H: number): string {
  const line = smoothPath(data, W, H);
  const pts = data.map((v, i) => {
    const max = Math.max(...data, 0.01);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    return { x: (i / (data.length - 1)) * W, y: H - ((v - min) / range) * H * 0.8 - H * 0.1 };
  });
  return line + ` L ${pts[pts.length - 1].x.toFixed(1)} ${H} L 0 ${H} Z`;
}
function polarToXY(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function arcD(cx: number, cy: number, r: number, a1: number, a2: number) {
  const s = polarToXY(cx, cy, r, a1);
  const e = polarToXY(cx, cy, r, a2);
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function Sparkline({ data, color, w = 72, h = 30 }: { data: number[]; color: string; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const id = `sg-${color.replace("#", "")}-${w}`;
  const path = smoothPath(data, w, h);
  const fill = areaPath(data, w, h);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${id})`} />
      <path d={path} stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HealthGauge({ score }: { score: number }) {
  const cx = 110, cy = 100, r = 80;
  const s = -135, e = 135, sweep = 270;
  const val = s + (Math.min(Math.max(score, 0), 100) / 100) * sweep;
  const color = score >= 70 ? "#22C55E" : score >= 40 ? "#FFB000" : "#EF4444";
  const label = score >= 80 ? "Excelente" : score >= 60 ? "Boa" : score >= 40 ? "Regular" : "Critica";
  const needle = polarToXY(cx, cy, r * 0.7, val);
  return (
    <svg width="220" height="160" viewBox="0 0 220 160">
      <path d={arcD(cx, cy, r, s, e)} stroke="#1E293B" strokeWidth="12" fill="none" strokeLinecap="round" />
      <path d={arcD(cx, cy, r, s, s + sweep * 0.33)} stroke="#EF4444" strokeWidth="12" fill="none" strokeLinecap="butt" opacity="0.5" />
      <path d={arcD(cx, cy, r, s + sweep * 0.33, s + sweep * 0.66)} stroke="#FFB000" strokeWidth="12" fill="none" strokeLinecap="butt" opacity="0.5" />
      <path d={arcD(cx, cy, r, s + sweep * 0.66, e)} stroke="#22C55E" strokeWidth="12" fill="none" strokeLinecap="butt" opacity="0.5" />
      <path d={arcD(cx, cy, r, s, val)} stroke={color} strokeWidth="12" fill="none" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="6" fill={color} />
      <line x1={cx} y1={cy} x2={needle.x.toFixed(1)} y2={needle.y.toFixed(1)} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <text x={cx} y={cy + 22} textAnchor="middle" fill="#fff" fontSize="26" fontWeight="900" fontFamily="system-ui">{score}</text>
      <text x={cx} y={cy + 40} textAnchor="middle" fill={color} fontSize="12" fontWeight="700" fontFamily="system-ui">{label}</text>
    </svg>
  );
}

function KpiCard({ icon, label, value, sub, color, spark, diff }: {
  icon: string; label: string; value: string; sub?: string;
  color: string; spark?: number[]; diff?: number;
}) {
  const [hov, setHov] = useState(false);
  const isUp = diff === undefined || diff >= 0;
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        background: "#0F172A",
        border: `1px solid ${hov ? color + "50" : "#1E293B"}`,
        borderRadius: "16px", padding: "20px 20px 16px",
        transition: "all 0.2s", cursor: "default",
        boxShadow: hov ? `0 12px 40px ${color}18` : "none",
        position: "relative", overflow: "hidden",
      }}
    >
      {hov && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: "1px",
          background: `linear-gradient(90deg, transparent, ${color}80, transparent)`,
        }} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10,
          background: `${color}18`, border: `1px solid ${color}30`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17,
        }}>{icon}</div>
        {spark && spark.length > 1 && <Sparkline data={spark} color={color} />}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 900, color: "#fff", letterSpacing: "-0.5px", marginBottom: 6 }}>{value}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {diff !== undefined && (
          <span style={{ fontSize: 12, fontWeight: 700, color: isUp ? "#22C55E" : "#EF4444" }}>
            {isUp ? "up" : "down"} {Math.abs(diff).toFixed(1)}%
          </span>
        )}
        {sub && <span style={{ fontSize: 12, color: "#94A3B8" }}>{sub}</span>}
      </div>
    </div>
  );
}

function PieChartSection({ items }: { items: { label: string; value: number; color: string }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const positivos = items.filter(i => i.value > 0);
  const total = positivos.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return null;

  const CX = 80, CY = 80, R = 62, RI = 36;
  let angle = -Math.PI / 2;
  const slices = positivos.map((item, idx) => {
    const pct = item.value / total;
    const a1 = angle;
    const a2 = angle + pct * 2 * Math.PI;
    angle = a2;
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    const x2 = CX + R * Math.cos(a2), y2 = CY + R * Math.sin(a2);
    const xi1 = CX + RI * Math.cos(a1), yi1 = CY + RI * Math.sin(a1);
    const xi2 = CX + RI * Math.cos(a2), yi2 = CY + RI * Math.sin(a2);
    const large = pct > 0.5 ? 1 : 0;
    return { ...item, pct, x1, y1, x2, y2, xi1, yi1, xi2, yi2, large, idx };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", width: "100%" }}>
        <svg viewBox="0 0 160 160" width={160} height={160} style={{ flexShrink: 0 }}>
          {slices.map((s, i) => {
            const scale = hov === i ? 1.06 : 1;
            return (
              <g key={i} style={{ cursor: "pointer", transform: `scale(${scale})`, transformOrigin: `${CX}px ${CY}px`, transition: "transform 0.2s ease" }}
                onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
                <path
                  d={`M ${s.xi1.toFixed(2)} ${s.yi1.toFixed(2)} L ${s.x1.toFixed(2)} ${s.y1.toFixed(2)} A ${R} ${R} 0 ${s.large} 1 ${s.x2.toFixed(2)} ${s.y2.toFixed(2)} L ${s.xi2.toFixed(2)} ${s.yi2.toFixed(2)} A ${RI} ${RI} 0 ${s.large} 0 ${s.xi1.toFixed(2)} ${s.yi1.toFixed(2)} Z`}
                  fill={s.color}
                  fillOpacity={hov === null || hov === i ? 1 : 0.5}
                  stroke="#0F172A" strokeWidth="2"
                />
              </g>
            );
          })}
          <circle cx={CX} cy={CY} r={RI - 2} fill="#0F172A" />
          {hov !== null ? (
            <>
              <text x={CX} y={CY - 6} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="800">
                {(slices[hov].pct * 100).toFixed(1)}%
              </text>
              <text x={CX} y={CY + 9} textAnchor="middle" fill="#94A3B8" fontSize="8">
                {slices[hov].label.split(" ")[0]}
              </text>
            </>
          ) : (
            <>
              <text x={CX} y={CY - 4} textAnchor="middle" fill="#fff" fontSize="10" fontWeight="800">Total</text>
              <text x={CX} y={CY + 10} textAnchor="middle" fill="#94A3B8" fontSize="8">composicao</text>
            </>
          )}
        </svg>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 12px", width: "100%" }}>
          {slices.map((s, i) => (
            <div key={i}
              onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: hov === null || hov === i ? 1 : 0.45, transition: "opacity 0.15s" }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: hov === i ? "#fff" : "#94A3B8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</div>
                <div style={{ fontSize: 10, color: s.color, fontWeight: 800 }}>{(s.pct * 100).toFixed(1)}%</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AreaChartSection({ dias }: { dias: DiaData[] }) {
  const [hov, setHov] = useState<number | null>(null);
  if (dias.length < 2) return (
    <div style={{ height: 200, display: "flex", alignItems: "center", justifyContent: "center", color: "#94A3B8", fontSize: 13 }}>
      Selecione um periodo com mais de 1 dia para ver o grafico
    </div>
  );

  const W = 800, H = 200;
  const fat = dias.map(d => d.faturamento);
  const luc = dias.map(d => Math.max(d.lucro, 0));
  const maxV = Math.max(...fat, 1);

  function toPoints(data: number[]) {
    return data.map((v, i) => ({
      x: (i / (data.length - 1)) * W,
      y: H - (Math.max(v, 0) / maxV) * H * 0.85 - H * 0.05,
    }));
  }
  function toSmoothPath(data: number[], fill = false) {
    const pts = toPoints(data);
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const cx1 = pts[i - 1].x + (pts[i].x - pts[i - 1].x) / 3;
      const cx2 = pts[i].x - (pts[i].x - pts[i - 1].x) / 3;
      d += ` C ${cx1.toFixed(1)} ${pts[i - 1].y.toFixed(1)}, ${cx2.toFixed(1)} ${pts[i].y.toFixed(1)}, ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
    }
    if (fill) d += ` L ${pts[pts.length - 1].x.toFixed(1)} ${H} L 0 ${H} Z`;
    return d;
  }

  const hovX = hov !== null ? (hov / (dias.length - 1)) * W : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 20, marginBottom: 16 }}>
        {[["#FF7A00", "Faturamento"], ["#22C55E", "Lucro"]].map(([c, l]) => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 12, height: 3, borderRadius: 2, background: c }} />
            <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>{l}</span>
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H + 28}`} width="100%" style={{ display: "block", cursor: "crosshair" }}
        onMouseMove={e => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const xRel = (e.clientX - rect.left) / rect.width * W;
          const idx = Math.round((xRel / W) * (dias.length - 1));
          setHov(Math.max(0, Math.min(idx, dias.length - 1)));
        }}
        onMouseLeave={() => setHov(null)}
      >
        <defs>
          <linearGradient id="gf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FF7A00" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#FF7A00" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="gl" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22C55E" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#22C55E" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(p => (
          <line key={p} x1="0" y1={(H - p * H * 0.85 - H * 0.05).toFixed(1)} x2={W} y2={(H - p * H * 0.85 - H * 0.05).toFixed(1)}
            stroke="#1E293B" strokeWidth="1" strokeDasharray="4,6" />
        ))}
        {[0.25, 0.5, 0.75, 1].map(p => (
          <text key={p} x="0" y={(H - p * H * 0.85 - H * 0.05 - 4).toFixed(1)} fill="#94A3B8" fontSize="9">
            {fmtBRL(maxV * p, true)}
          </text>
        ))}
        <path d={toSmoothPath(fat, true)} fill="url(#gf)" />
        <path d={toSmoothPath(luc, true)} fill="url(#gl)" />
        <path d={toSmoothPath(fat)} stroke="#FF7A00" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d={toSmoothPath(luc)} stroke="#22C55E" strokeWidth="2" fill="none" strokeLinecap="round" />
        {hovX !== null && hov !== null && (
          <>
            <line x1={hovX.toFixed(1)} y1="0" x2={hovX.toFixed(1)} y2={H} stroke="#94A3B8" strokeWidth="1" strokeDasharray="3,4" />
            {[{ data: fat, color: "#FF7A00" }, { data: luc, color: "#22C55E" }].map(({ data, color }) => {
              const pts = toPoints(data);
              const pt = pts[hov];
              return pt ? (
                <g key={color}>
                  <circle cx={pt.x.toFixed(1)} cy={pt.y.toFixed(1)} r="5" fill={color} />
                  <circle cx={pt.x.toFixed(1)} cy={pt.y.toFixed(1)} r="8" fill={color} fillOpacity="0.2" />
                </g>
              ) : null;
            })}
          </>
        )}
        {dias.map((d, i) => {
          const x = (i / (dias.length - 1)) * W;
          const show = i === 0 || i === dias.length - 1 || i % Math.max(1, Math.ceil(dias.length / 7)) === 0;
          return show ? (
            <text key={i} x={x.toFixed(1)} y={H + 18} textAnchor="middle" fill="#94A3B8" fontSize="10">{d.label}</text>
          ) : null;
        })}
      </svg>
      {hov !== null && (
        <div style={{
          marginTop: 8, padding: "8px 14px", background: "#1E293B",
          borderRadius: 10, display: "inline-flex", gap: 20,
          border: "1px solid #334155", fontSize: 12,
        }}>
          <span style={{ color: "#94A3B8", fontWeight: 700 }}>{dias[hov]?.label}</span>
          <span style={{ color: "#FF7A00", fontWeight: 700 }}>Fat: {fmtBRL(dias[hov]?.faturamento ?? 0)}</span>
          <span style={{ color: "#22C55E", fontWeight: 700 }}>Lucro: {fmtBRL(Math.max(dias[hov]?.lucro ?? 0, 0))}</span>
        </div>
      )}
    </div>
  );
}

const RANK_STYLE = [
  { icon: "gold", color: "#FFB000" },
  { icon: "silver", color: "#94A3B8" },
  { icon: "bronze", color: "#CD7F32" },
];

function TopProductRow({ p, rank }: { p: TopProduto; rank: number }) {
  const [hov, setHov] = useState(false);
  const rs = RANK_STYLE[rank - 1];
  const rankIcon = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "36px 44px 1fr 110px 100px 80px 56px",
        alignItems: "center", gap: 12, padding: "12px 16px",
        borderRadius: 12,
        background: hov ? "rgba(255,122,0,0.06)" : "rgba(255,255,255,0.02)",
        border: `1px solid ${hov ? "rgba(255,122,0,0.25)" : "transparent"}`,
        transition: "all 0.15s",
      }}
    >
      <div style={{ textAlign: "center", fontSize: rank <= 3 ? 20 : 13, fontWeight: 800, color: rs?.color ?? "#94A3B8" }}>
        {rankIcon}
      </div>
      <div style={{ width: 40, height: 40, borderRadius: 10, overflow: "hidden", background: "#1E293B", border: "1px solid #334155", flexShrink: 0 }}>
        {p.thumbnail
          ? <img src={p.thumbnail.replace("http://","https://")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={e => { const t = e.target as HTMLImageElement; t.style.display="none"; if (t.parentElement) t.parentElement.innerHTML='<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:18px">&#x1F6D2;</div>'; }} />
          : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🛒</div>
        }
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nome}</div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>{p.sku ? `SKU: ${p.sku}` : "—"} · {p.qtd} un.</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#FFB000" }}>{fmtBRL(p.faturamento, true)}</div>
        <div style={{ fontSize: 10, color: "#94A3B8" }}>receita</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: p.lucro >= 0 ? "#22C55E" : "#EF4444" }}>{fmtBRL(p.lucro, true)}</div>
        <div style={{ fontSize: 10, color: "#94A3B8" }}>lucro</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: p.margem >= 20 ? "#22C55E" : p.margem >= 10 ? "#FFB000" : "#EF4444" }}>
          {p.margem.toFixed(1)}%
        </div>
        <div style={{ fontSize: 10, color: "#94A3B8" }}>margem</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{p.qtd}</div>
        <div style={{ fontSize: 10, color: "#94A3B8" }}>vendas</div>
      </div>
    </div>
  );
}

function AlertBadge({ icon, title, msg, color }: { icon: string; title: string; msg: string; color: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12, padding: "14px 16px",
      background: `${color}0D`, border: `1px solid ${color}30`, borderRadius: 12,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: 8, background: `${color}20`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, flexShrink: 0,
      }}>{icon}</div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: "#94A3B8" }}>{msg}</div>
      </div>
    </div>
  );
}

function LojasDropdown({ lojas, selecionadas, onChange }: {
  lojas: Loja[];
  selecionadas: Set<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora
  React.useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const todas = lojas.length === 0 || selecionadas.size === lojas.length || selecionadas.size === 0;
  const label = lojas.length === 0
    ? "Minhas lojas"
    : todas
    ? "Todas as lojas"
    : selecionadas.size === 1
    ? (lojas.find(l => selecionadas.has(l.id))?.nickname ?? "1 loja")
    : `${selecionadas.size} lojas`;

  function toggleLoja(id: string) {
    // Seleção exclusiva: clicar numa loja mostra só ela
    // Clicar na mesma loja já selecionada volta pra "todas"
    if (selecionadas.size === 1 && selecionadas.has(id)) {
      onChange(new Set(lojas.map(l => l.id))); // volta pra todas
    } else {
      onChange(new Set([id])); // seleciona exclusivamente
    }
  }
  function toggleTodas() {
    onChange(new Set(lojas.map(l => l.id)));
  }

  const mktColor = (m: string) => m === "Shopee" ? "#EE4D2D" : "#22C55E";
  const mktLabel = (m: string) => m === "Shopee" ? "🟠" : "🟢";

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setAberto(v => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: "#0F172A", border: "1px solid #334155",
          borderRadius: 10, padding: "8px 14px", cursor: "pointer",
          color: "#fff", fontSize: 13, fontWeight: 700,
          transition: "border-color 0.15s",
        }}
        onMouseEnter={e => (e.currentTarget.style.borderColor = "#FF7A00")}
        onMouseLeave={e => (e.currentTarget.style.borderColor = "#334155")}
      >
        <span style={{ fontSize: 14 }}>🏪</span>
        <span>{label}</span>
        <span style={{ color: "#94A3B8", fontSize: 11, marginLeft: 2 }}>{aberto ? "▲" : "▼"}</span>
      </button>

      {aberto && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0,
          background: "#0F172A", border: "1px solid #1E293B",
          borderRadius: 14, padding: 8, minWidth: 220, zIndex: 999,
          boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
        }}>
          {/* Todas */}
          <div
            onClick={toggleTodas}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 12px", borderRadius: 10, cursor: "pointer",
              background: todas ? "rgba(255,122,0,0.1)" : "transparent",
              marginBottom: 4,
            }}
            onMouseEnter={e => { if (!todas) (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = todas ? "rgba(255,122,0,0.1)" : "transparent"; }}
          >
            <div style={{
              width: 16, height: 16, borderRadius: 4, flexShrink: 0,
              background: todas ? "#FF7A00" : "transparent",
              border: `2px solid ${todas ? "#FF7A00" : "#334155"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {todas && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: todas ? "#FF7A00" : "#fff" }}>Todas as lojas</span>
          </div>

          {lojas.length === 0 && (
            <div style={{ padding: "12px 16px", fontSize: 13, color: "#94A3B8", textAlign: "center" }}>
              Nenhuma loja conectada.<br />
              <span style={{ fontSize: 11, color: "#64748B" }}>Vá em Configurações para conectar.</span>
            </div>
          )}

          {lojas.length > 0 && <div style={{ height: 1, background: "#1E293B", margin: "4px 0 8px" }} />}

          {lojas.map(loja => {
            const sel = selecionadas.has(loja.id);
            const cor = mktColor(loja.marketplace);
            return (
              <div
                key={loja.id}
                onClick={() => toggleLoja(loja.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "9px 12px", borderRadius: 10, cursor: "pointer",
                  background: sel && !todas ? `${cor}10` : "transparent",
                  marginBottom: 2,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = sel && !todas ? `${cor}18` : "rgba(255,255,255,0.04)"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = sel && !todas ? `${cor}10` : "transparent"; }}
              >
                <div style={{
                  width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                  background: sel && !todas ? cor : "transparent",
                  border: `2px solid ${sel && !todas ? cor : "#334155"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {sel && !todas && <span style={{ color: "#fff", fontSize: 10, fontWeight: 900 }}>✓</span>}
                </div>
                <span style={{ fontSize: 11 }}>{mktLabel(loja.marketplace)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(loja.nickname ?? loja.nome)} {loja.marketplace === "ML" ? "Mercado Livre" : loja.marketplace}
                  </div>
                  <div style={{ fontSize: 10, color: cor, fontWeight: 700 }}>{loja.marketplace === "ML" ? "Mercado Livre" : "Shopee"}</div>
                </div>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: cor, flexShrink: 0, boxShadow: `0 0 6px ${cor}` }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({ title, subtitle, action, children }: {
  title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div style={{
      background: "#0F172A", border: "1px solid #1E293B",
      borderRadius: 20, padding: "24px 24px 20px",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 3 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export default function DashboardPage() {
  const hoje = hojeISO();
  const seteDias = addDays(hoje, -6);

  const [dateFrom, setDateFrom] = useState(seteDias);
  const [dateTo,   setDateTo]   = useState(hoje);
  const [loading,  setLoading]  = useState(true);
  const [erro,     setErro]     = useState<string | null>(null);
  const [conta,    setConta]    = useState("CDS");
  const [mlConectado,     setMlConectado]     = useState(false);
  const [shopeeConectado, setShopeeConectado] = useState(false);
  const [lojas,            setLojas]            = useState<Loja[]>([]);
  const [lojasSelecionadas, setLojasSelecionadas] = useState<Set<string>>(new Set());

  const [kpis, setKpis] = useState({
    faturamento: 0, pedidos: 0, ticket: 0, lucro: 0,
    margem: 0, unidades: 0, roi: 0, comissoes: 0,
  });
  const [dias,     setDias]     = useState<DiaData[]>([]);
  const [tops,       setTops]       = useState<TopProduto[]>([]);
  const [loss,       setLoss]       = useState<TopProduto[]>([]);
  const [topsML,     setTopsML]     = useState<TopProduto[]>([]);
  const [topsShopee, setTopsShopee] = useState<TopProduto[]>([]);
  const [showBothMkt, setShowBothMkt] = useState(false);
  const [alertas,  setAlertas]  = useState<{ icon: string; title: string; msg: string; color: string }[]>([]);
  const [anuncios, setAnuncios] = useState<Anuncio[]>([]);
  const [score,    setScore]    = useState(0);
  const [sparkFat, setSparkFat] = useState<number[]>([]);
  const [sparkLuc, setSparkLuc] = useState<number[]>([]);

  useEffect(() => {
    // Busca userId via session para filtrar anúncios corretamente (multi-tenant)
    fetch("/api/auth/me")
      .then(r => r.json())
      .then(({ userId }) => {
        if (!userId) return;
        supabase.from("anuncios")
          .select("ml_item_id, thumbnail, nome, sku, marketplace, custo_produto, preco_anuncio, margem_contribuicao")
          .eq("ativo", true)
          .eq("user_id", userId)
          .then(({ data }) => { if (data) setAnuncios(data as Anuncio[]); });
      })
      .catch(() => {});

    fetch("/api/lojas")
      .then(r => r.json())
      .then((data: Loja[]) => {
        if (Array.isArray(data) && data.length > 0) {
          setLojas(data);
          setLojasSelecionadas(new Set(data.map(l => l.id)));
        }
      })
      .catch(() => {});
  }, []);

  const carregar = useCallback(async (from: string, to: string, lojasAtivas?: Set<string>) => {
    setLoading(true);
    setErro(null);
    const sel = lojasAtivas ?? lojasSelecionadas;
    // Determina quais marketplaces buscar baseado nas lojas selecionadas
    const lojasArr = lojas.length > 0 ? lojas : [];
    const selecionadasArr = lojasArr.filter(l => sel.size === 0 || sel.has(l.id));
    const buscarML     = selecionadasArr.length === 0 || selecionadasArr.some(l => l.marketplace === "ML");
    const buscarShopee = selecionadasArr.length === 0 || selecionadasArr.some(l => l.marketplace === "Shopee");

    try {
      const [mlData, shopeeData] = await Promise.all([
        buscarML     ? fetch(`/api/ml/vendas?date_from=${from}&date_to=${to}`).then(r => r.json()).catch(() => null)     : Promise.resolve(null),
        buscarShopee ? fetch(`/api/shopee/vendas?date_from=${from}&date_to=${to}`).then(r => r.json()).catch(() => null) : Promise.resolve(null),
      ]);

      const mlOk     = mlData     && !mlData.erro;
      const shopeeOk = shopeeData && !shopeeData.erro && !shopeeData.semConexao;

      setMlConectado(mlOk);
      setShopeeConectado(shopeeOk);

      if (!mlOk && !shopeeOk) {
        setErro(mlData?.mensagem || "Nenhum marketplace conectado.");
        setLoading(false);
        return;
      }

      // Usa o primeiro nome disponível (ML e Shopee retornam o mesmo nickname do usuário)
      const contaNome = (mlOk ? mlData.conta : null) || (shopeeOk ? shopeeData.conta : null) || "CDS";
      setConta(contaNome);

      const mlRowsFull     = (mlOk     ? mlData.rows     ?? [] : []) as VendaRow[];
      const shopeeRowsFull = (shopeeOk ? shopeeData.rows ?? [] : []) as VendaRow[];
      const mlRows     = mlRowsFull.filter((r: VendaRow) => r.status === "paid");
      const shopeeRows = shopeeRowsFull.filter((r: VendaRow) => r.status === "paid");
      const rows: VendaRow[] = [...mlRows, ...shopeeRows];

      // Detecta se há dados de ambas as plataformas
      setShowBothMkt(mlRows.length > 0 && shopeeRows.length > 0);

      const fat       = rows.reduce((s, r) => s + r.faturamento, 0);
      const lucro     = rows.reduce((s, r) => s + r.margemContrib, 0);
      const custo     = rows.reduce((s, r) => s + r.custo, 0);
      const comissoes = rows.reduce((s, r) => s + r.tarifaVenda, 0);
      const frete     = rows.reduce((s, r) => s + r.freteComprador + r.freteVendedor, 0);
      const unidades  = rows.reduce((s, r) => s + r.qtd, 0);
      const pedidos   = new Set(rows.map(r => r.orderId)).size;
      const ticket    = pedidos > 0 ? fat / pedidos : 0;
      const margem    = fat > 0 ? (lucro / fat) * 100 : 0;
      const roi       = custo > 0 ? (lucro / custo) * 100 : 0;

      setKpis({ faturamento: fat, pedidos, ticket, lucro, margem, unidades, roi, comissoes });

      let s = 0;
      if (margem >= 20) s += 40; else if (margem >= 10) s += 20; else if (margem > 0) s += 10;
      if (pedidos > 0) s += 20;
      if (fat > 1000) s += 20;
      if (roi > 50) s += 20;
      setScore(Math.min(s, 100));

      const mapaD = new Map<string, DiaData>();
      let cur = from;
      while (cur <= to) {
        mapaD.set(cur, { data: cur, label: fmtData(cur), faturamento: 0, lucro: 0, custo: 0, comissao: 0, frete: 0 });
        cur = addDays(cur, 1);
      }
      for (const r of rows) {
        const d = mapaD.get(r.data);
        if (d) {
          d.faturamento += r.faturamento;
          d.lucro       += r.margemContrib;
          d.custo       += r.custo;
          d.comissao    += r.tarifaVenda;
          d.frete       += r.freteComprador + r.freteVendedor;
        }
      }
      const diasArr = Array.from(mapaD.values()).sort((a, b) => a.data.localeCompare(b.data));
      setDias(diasArr);
      setSparkFat(diasArr.map(d => d.faturamento));
      setSparkLuc(diasArr.map(d => Math.max(d.lucro, 0)));

      // Constrói mapa de tops por marketplace
      function buildTops(rowsSubset: VendaRow[]): { all: TopProduto[]; tops: TopProduto[]; loss: TopProduto[] } {
        const mapA = new Map<string, TopProduto>();
        for (const r of rowsSubset) {
          const key = r.mlItemId || r.anuncio;
          const ex  = mapA.get(key);
          const rawThumb = anuncios.find(a => a.ml_item_id === r.mlItemId || a.ml_item_id?.split("-")[0] === r.mlItemId?.split("-")[0])?.thumbnail ?? null;
          const thumb = rawThumb ? rawThumb.replace("http://", "https://") : null;
          if (ex) {
            ex.faturamento += r.faturamento;
            ex.lucro       += r.margemContrib;
            ex.qtd         += r.qtd;
          } else {
            mapA.set(key, { mlItemId: r.mlItemId, nome: r.anuncio, sku: r.sku, thumbnail: thumb, faturamento: r.faturamento, lucro: r.margemContrib, qtd: r.qtd, margem: 0 });
          }
        }
        const all = Array.from(mapA.values()).map(p => ({ ...p, margem: p.faturamento > 0 ? (p.lucro / p.faturamento) * 100 : 0 }));
        return {
          all,
          tops: [...all].sort((a, b) => b.faturamento - a.faturamento).slice(0, 10),
          loss: [...all].filter(p => p.lucro < 0).sort((a, b) => a.lucro - b.lucro).slice(0, 5),
        };
      }

      const builtAll    = buildTops(rows);
      const builtML     = buildTops(mlRows);
      const builtShopee = buildTops(shopeeRows);

      const topsSorted = builtAll.tops;
      const lossSorted = builtAll.loss;

      // Busca thumbnails para itens ML sem thumbnail
      const semThumb = topsSorted.concat(lossSorted).filter(p => !p.thumbnail && p.mlItemId);
      if (semThumb.length) {
        const ids = [...new Set(semThumb.map(p => p.mlItemId))].join(",");
        try {
          const tr = await fetch(`/api/ml/item-thumbnails?ids=${ids}`);
          const tMap: Record<string, string> = await tr.json();
          topsSorted.forEach(p => { if (!p.thumbnail && tMap[p.mlItemId]) p.thumbnail = tMap[p.mlItemId]; });
          lossSorted.forEach(p => { if (!p.thumbnail && tMap[p.mlItemId]) p.thumbnail = tMap[p.mlItemId]; });
          builtML.tops.forEach(p => { if (!p.thumbnail && tMap[p.mlItemId]) p.thumbnail = tMap[p.mlItemId]; });
        } catch { /* silencioso */ }
      }

      setTops(topsSorted);
      setLoss(lossSorted);
      setTopsML(builtML.tops);
      setTopsShopee(builtShopee.tops);

      const todosOsProdutos = builtAll.all;
      const al: typeof alertas = [];
      const semMargem = todosOsProdutos.filter(p => p.margem < 10 && p.margem >= 0);
      if (semMargem.length) al.push({ icon: "⚠️", title: `${semMargem.length} produto${semMargem.length > 1 ? "s" : ""} com margem abaixo de 10%`, msg: "Revise o preco ou os custos destes anuncios.", color: "#FFB000" });
      const prejuizo = todosOsProdutos.filter(p => p.lucro < 0);
      if (lossSorted.length) al.push({ icon: "🔴", title: `${prejuizo.length} produto${prejuizo.length > 1 ? "s" : ""} gerando prejuizo`, msg: "Estes anuncios custam mais do que rendem.", color: "#EF4444" });
      if (margem > 0 && margem < 15) al.push({ icon: "📉", title: "Margem geral abaixo do recomendado", msg: "A meta saudavel e acima de 15% de margem liquida.", color: "#EF4444" });
      if (!al.length && pedidos > 0) al.push({ icon: "✅", title: "Tudo certo por aqui!", msg: "Seus anuncios estao com boa saude financeira.", color: "#22C55E" });
      setAlertas(al);

    } catch (e) { console.error("[dashboard] carregar error:", e); setErro("Erro ao carregar dados."); }
    setLoading(false);
  }, [anuncios, lojas]);

  useEffect(() => { carregar(dateFrom, dateTo); }, [dateFrom, dateTo, lojasSelecionadas, carregar]);

  const totalCusto    = dias.reduce((s, d) => s + d.custo, 0);
  const totalComissao = dias.reduce((s, d) => s + d.comissao, 0);
  const totalFrete    = dias.reduce((s, d) => s + d.frete, 0);
  const totalLucro    = kpis.lucro;

  const balItems = [
    { label: "Receita Bruta",   value: kpis.faturamento,              color: "#FF7A00" },
    { label: "Custo Produtos",  value: -totalCusto,                   color: "#EF4444" },
    { label: "Comissoes",       value: -totalComissao,                 color: "#F97316" },
    { label: "Fretes",          value: -totalFrete,                    color: "#FB923C" },
    { label: "Lucro Liquido",   value: totalLucro,                     color: totalLucro >= 0 ? "#22C55E" : "#EF4444" },
  ];

  const hoje2 = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });

  const produtosBaixaMargem = tops.filter(p => p.margem < 10 && p.margem >= 0);
  const comissaoPct  = kpis.faturamento > 0 ? (totalComissao / kpis.faturamento) * 100 : 0;
  const fretePct     = kpis.faturamento > 0 ? (totalFrete / kpis.faturamento) * 100 : 0;
  const lucroAdicionalEstimado = produtosBaixaMargem.reduce((sum, p) => {
    return sum + Math.max(p.faturamento * 0.20 - p.lucro, 0);
  }, 0);
  const reducaoPrejuizo = loss.reduce((sum, p) => sum + Math.abs(p.lucro), 0);
  const projetoMargem  = kpis.margem + (kpis.faturamento > 0 ? (lucroAdicionalEstimado / kpis.faturamento) * 100 : 0);

  const cdsInsights: { prioridade: string; cor: string; icone: string; titulo: string; texto: string; acao: string }[] = [];
  if (loss.length > 0) cdsInsights.push({
    prioridade: "Critica", cor: "#EF4444", icone: "💸",
    titulo: `${loss.length} produto${loss.length > 1 ? "s" : ""} gerando prejuizo`,
    texto: `Cada venda esta te custando dinheiro. Pausar ou corrigir esses anuncios pode recuperar ${fmtBRL(reducaoPrejuizo, true)}/mes.`,
    acao: "Corrigir agora",
  });
  if (produtosBaixaMargem.length > 0) cdsInsights.push({
    prioridade: "Alta", cor: "#F97316", icone: "⚠️",
    titulo: `${produtosBaixaMargem.length} produto${produtosBaixaMargem.length > 1 ? "s" : ""} com margem abaixo de 10%`,
    texto: `Estao vendendo, mas quase sem lucro. Ajustando o preco para 20% de margem, voce pode ganhar ${fmtBRL(lucroAdicionalEstimado, true)} a mais.`,
    acao: "Ver produtos",
  });
  if (kpis.margem < 15 && kpis.pedidos > 0) cdsInsights.push({
    prioridade: "Alta", cor: "#F97316", icone: "📉",
    titulo: `Margem geral de ${kpis.margem.toFixed(1)}% — abaixo da meta`,
    texto: `A meta saudavel para marketplace e 15%+. Ajustar apenas os produtos criticos pode resolver sem precisar vender mais.`,
    acao: "Ver analise",
  });
  if (comissaoPct > 14) cdsInsights.push({
    prioridade: "Media", cor: "#FFB000", icone: "🏷️",
    titulo: `Comissoes consumindo ${comissaoPct.toFixed(1)}% da receita`,
    texto: `As taxas representam ${fmtBRL(totalComissao, true)}. Revise o tipo de anuncio para otimizar as tarifas.`,
    acao: "Analisar taxas",
  });
  if (fretePct > 8) cdsInsights.push({
    prioridade: "Media", cor: "#FFB000", icone: "🚚",
    titulo: `Frete consumindo ${fretePct.toFixed(1)}% da receita`,
    texto: `O custo logistico esta impactando a margem. Revise o peso declarado dos produtos e a configuracao de frete gratis.`,
    acao: "Revisar frete",
  });
  const melhorProduto = tops.find(p => p.margem >= 18);
  if (melhorProduto) cdsInsights.push({
    prioridade: "Positiva", cor: "#22C55E", icone: "🏆",
    titulo: `"${melhorProduto.nome.slice(0, 28)}..." e seu produto mais saudavel`,
    texto: `Margem de ${melhorProduto.margem.toFixed(1)}% e ${fmtBRL(melhorProduto.faturamento, true)} de receita. Candidato ideal para campanhas ADS.`,
    acao: "Criar campanha",
  });
  if (kpis.margem >= 20 && loss.length === 0) cdsInsights.push({
    prioridade: "Positiva", cor: "#22C55E", icone: "✅",
    titulo: "Operacao saudavel — parabens!",
    texto: `Margem de ${kpis.margem.toFixed(1)}%, sem produtos em prejuizo. Continue monitorando os custos.`,
    acao: "Ver detalhes",
  });

  const cdsAcoes: { prioridade: string; cor: string; acao: string; impacto: string; motivo: string }[] = [];
  if (loss[0]) cdsAcoes.push({
    prioridade: "Critica", cor: "#EF4444",
    acao: `Revisar preco de "${loss[0].nome.slice(0, 28)}..."`,
    impacto: `Recuperar ${fmtBRL(Math.abs(loss[0].lucro), true)}/mes`,
    motivo: "Produto gerando prejuizo em cada venda.",
  });
  if (produtosBaixaMargem.length > 0) cdsAcoes.push({
    prioridade: "Alta", cor: "#F97316",
    acao: `Aumentar preco de ${produtosBaixaMargem.length} anuncio${produtosBaixaMargem.length > 1 ? "s" : ""} com margem < 10%`,
    impacto: `+${fmtBRL(lucroAdicionalEstimado, true)} de lucro estimado`,
    motivo: "Margem abaixo do minimo recomendado.",
  });
  if (melhorProduto) cdsAcoes.push({
    prioridade: "Media", cor: "#FFB000",
    acao: `Criar campanha ADS para "${melhorProduto.nome.slice(0, 25)}..."`,
    impacto: "Ampliar volume no produto mais lucrativo",
    motivo: "Produto com melhor relacao margem x volume.",
  });
  cdsAcoes.push({
    prioridade: "Rotina", cor: "#6366F1",
    acao: "Sincronizar SKUs e precos esta semana",
    impacto: "Manter analises precisas",
    motivo: "Dados desatualizados geram insights errados.",
  });

  return (
    <div style={{ padding: "24px 28px" }}>
      <style>{`
        @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulse  { 0%,100% { opacity:1; } 50% { opacity:.5; } }
        .dash-anim { animation: fadeUp 0.4s ease both; }
      `}</style>

      {/* HERO */}
      <div className="dash-anim" style={{
        marginBottom: 28,
        background: "linear-gradient(135deg, #0F172A 0%, #1a0a00 100%)",
        border: "1px solid #1E293B",
        borderRadius: 20, padding: "28px 32px",
        position: "relative", zIndex: 50,
      }}>
        <div style={{
          position: "absolute", top: -60, right: -60,
          width: 300, height: 300, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,122,0,0.12) 0%, transparent 70%)",
          pointerEvents: "none",
        }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 900, color: "#fff", marginBottom: 6 }}>
              {saudacao()}, {conta} 👋
            </div>
            <div style={{ fontSize: 14, color: "#94A3B8" }}>
              {hoje2.charAt(0).toUpperCase() + hoje2.slice(1)}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <LojasDropdown
              lojas={lojas}
              selecionadas={lojasSelecionadas}
              onChange={(ids) => {
                setLojasSelecionadas(ids);
                carregar(dateFrom, dateTo, ids);
              }}
            />
            <DateRangePicker from={dateFrom} to={dateTo} onChange={(f, t) => { setDateFrom(f); setDateTo(t); }} />
          </div>
        </div>
      </div>

      {/* ERROR */}
      {erro && (
        <div style={{
          background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
          borderRadius: 14, padding: "14px 20px", color: "#fca5a5", fontSize: 13, marginBottom: 24,
        }}>
          ⚠️ {erro.includes("conectado") || erro.includes("expirada")
            ? "Conecte sua conta do Mercado Livre ou Shopee em Configuracoes para ver os dados."
            : erro}
        </div>
      )}

      {/* SKELETON */}
      {loading && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
          {[...Array(8)].map((_, i) => (
            <div key={i} style={{ background: "#0F172A", border: "1px solid #1E293B", borderRadius: 16, padding: 20, height: 110 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: "#1E293B", marginBottom: 12 }} />
              <div style={{ height: 10, background: "#1E293B", borderRadius: 4, width: "60%", marginBottom: 8 }} />
              <div style={{ height: 24, background: "#1E293B", borderRadius: 4, width: "80%" }} />
            </div>
          ))}
        </div>
      )}

      {!loading && !erro && (
        <>
          {/* KPI CARDS */}
          <div className="dash-anim" style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(175px, 1fr))",
            gap: 14, marginBottom: 24, animationDelay: "0.05s",
          }}>
            <KpiCard icon="💰" label="Faturamento"   value={fmtBRL(kpis.faturamento, true)} sub={`${kpis.unidades} unid.`} color="#FF7A00" spark={sparkFat} />
            <KpiCard icon="✨" label="Lucro Liquido" value={fmtBRL(kpis.lucro, true)}        color={kpis.lucro >= 0 ? "#22C55E" : "#EF4444"} spark={sparkLuc} sub="apos custos" />
            <KpiCard icon="📊" label="Margem Media"  value={`${kpis.margem.toFixed(1)}%`}    color={kpis.margem >= 20 ? "#22C55E" : kpis.margem >= 10 ? "#FFB000" : "#EF4444"} sub="contribuicao" />
            <KpiCard icon="📦" label="Pedidos"       value={String(kpis.pedidos)}             color="#6366F1" sub="pagos" />
            <KpiCard icon="🎯" label="Ticket Medio"  value={fmtBRL(kpis.ticket, true)}       color="#FFB000" sub="por pedido" />
            <KpiCard icon="🔄" label="ROI"           value={`${kpis.roi.toFixed(0)}%`}       color={kpis.roi >= 50 ? "#22C55E" : "#FFB000"} sub="retorno s/ custo" />
            <KpiCard icon="🏷️" label="Comissoes"    value={fmtBRL(kpis.comissoes, true)}     color="#EF4444" sub="taxas marketplace" />
            <KpiCard icon="📈" label="Unidades"      value={String(kpis.unidades)}            color="#06B6D4" sub="vendidas" />
          </div>

          {/* EVOLUCAO + BALANCETE */}
          <div className="dash-anim" style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 16, marginBottom: 24, animationDelay: "0.1s" }}>
            <Section title="Evolucao de Vendas" subtitle="Faturamento e lucro no periodo selecionado">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 20, alignItems: "center" }}>
                <AreaChartSection dias={dias} />
                <div style={{ borderLeft: "1px solid #1E293B", paddingLeft: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12 }}>Composicao</div>
                  <PieChartSection items={[
                    { label: "Lucro Liquido", value: Math.max(totalLucro, 0), color: "#22C55E" },
                    { label: "Custo Produtos", value: totalCusto, color: "#6366F1" },
                    { label: "Comissoes", value: totalComissao, color: "#F97316" },
                    { label: "Fretes", value: totalFrete, color: "#06B6D4" },
                  ]} />
                </div>
              </div>
            </Section>

            <Section title="Balancete" subtitle="Composicao do resultado">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {balItems.map(item => {
                  const maxAbs = Math.max(...balItems.map(i => Math.abs(i.value)), 1);
                  const pct = (Math.abs(item.value) / maxAbs) * 100;
                  return (
                    <div key={item.label}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 600 }}>{item.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: item.color }}>{fmtBRL(item.value, true)}</span>
                      </div>
                      <div style={{ height: 6, background: "#1E293B", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: item.color, borderRadius: 4, transition: "width 0.6s ease" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          </div>

          {/* TOP PRODUTOS */}
          {(tops.length > 0 || topsML.length > 0 || topsShopee.length > 0) && (
            <div className="dash-anim" style={{ marginBottom: 24, animationDelay: "0.15s" }}>
              {showBothMkt ? (
                // Duas plataformas: mostra top 10 lado a lado
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  {/* Top ML */}
                  {topsML.length > 0 && (
                    <Section
                      title="🛒 Top Produtos — Mercado Livre"
                      subtitle={`${topsML.length} melhores por faturamento`}
                      action={<span style={{ fontSize: 11, color: "#22C55E", fontWeight: 700 }}>ML</span>}
                    >
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: "36px 44px 1fr 90px 72px 56px",
                        gap: 8, padding: "0 12px 8px",
                        borderBottom: "1px solid #1E293B", marginBottom: 6,
                      }}>
                        {["", "", "Produto", "Receita", "Margem", "Qtd"].map((h, i) => (
                          <div key={i} style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: i > 2 ? "right" : "left" }}>{h}</div>
                        ))}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {topsML.map((p, i) => <TopProductRow key={p.mlItemId || i} p={p} rank={i + 1} />)}
                      </div>
                    </Section>
                  )}
                  {/* Top Shopee */}
                  {topsShopee.length > 0 && (
                    <Section
                      title="🛍 Top Produtos — Shopee"
                      subtitle={`${topsShopee.length} melhores por faturamento`}
                      action={<span style={{ fontSize: 11, color: "#EE4D2D", fontWeight: 700 }}>Shopee</span>}
                    >
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: "36px 44px 1fr 90px 72px 56px",
                        gap: 8, padding: "0 12px 8px",
                        borderBottom: "1px solid #1E293B", marginBottom: 6,
                      }}>
                        {["", "", "Produto", "Receita", "Margem", "Qtd"].map((h, i) => (
                          <div key={i} style={{ fontSize: 9, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: i > 2 ? "right" : "left" }}>{h}</div>
                        ))}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {topsShopee.map((p, i) => <TopProductRow key={p.mlItemId || i} p={p} rank={i + 1} />)}
                      </div>
                    </Section>
                  )}
                </div>
              ) : (
                // Uma plataforma: top 10 completo
                <Section
                  title="🏆 Top Produtos"
                  subtitle="Melhores anuncios no periodo"
                  action={<span style={{ fontSize: 11, color: "#94A3B8" }}>{tops.length} produtos</span>}
                >
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "36px 44px 1fr 110px 100px 80px 56px",
                    gap: 12, padding: "0 16px 10px",
                    borderBottom: "1px solid #1E293B", marginBottom: 8,
                  }}>
                    {["", "", "Produto", "Receita", "Lucro", "Margem", "Qtd"].map((h, i) => (
                      <div key={i} style={{ fontSize: 10, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.5px", textAlign: i > 2 ? "right" : "left" }}>{h}</div>
                    ))}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {tops.map((p, i) => <TopProductRow key={p.mlItemId || i} p={p} rank={i + 1} />)}
                  </div>
                </Section>
              )}
            </div>
          )}

          {/* PREJUIZO + SAUDE + ALERTAS */}
          <div className="dash-anim" style={{ display: "grid", gridTemplateColumns: loss.length ? "1fr 260px" : "1fr", gap: 16, marginBottom: 24, animationDelay: "0.2s" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <Section title="🩺 Saude Financeira" subtitle="Baseada em margem, volume e retorno">
                <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
                  <HealthGauge score={score} />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10 }}>
                    {[
                      { label: "Margem", value: `${kpis.margem.toFixed(1)}%`, ok: kpis.margem >= 15 },
                      { label: "ROI", value: `${kpis.roi.toFixed(0)}%`, ok: kpis.roi >= 30 },
                      { label: "Pedidos", value: String(kpis.pedidos), ok: kpis.pedidos > 0 },
                      { label: "Lucro", value: fmtBRL(kpis.lucro, true), ok: kpis.lucro > 0 },
                    ].map(item => (
                      <div key={item.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "#94A3B8" }}>{item.label}</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{item.value}</span>
                          <span style={{ fontSize: 14 }}>{item.ok ? "✅" : "⚠️"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </Section>

              {alertas.length > 0 && (
                <Section title="🔔 Alertas" subtitle="Atencao necessaria">
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {alertas.map((a, i) => <AlertBadge key={i} {...a} />)}
                  </div>
                </Section>
              )}
            </div>

            {loss.length > 0 && (
              <Section title="🔴 Em Prejuizo" subtitle="Produtos que estao perdendo dinheiro">
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {loss.map((p, i) => (
                    <div key={i} style={{ padding: "12px 14px", background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, overflow: "hidden", background: "#1E293B", flexShrink: 0 }}>
                          {p.thumbnail
                            ? <img src={p.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>🛒</div>
                          }
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.nome}
                        </div>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 11, color: "#EF4444", fontWeight: 700 }}>Perda: {fmtBRL(p.lucro)}</span>
                        <span style={{ fontSize: 11, color: "#94A3B8" }}>Margem: {p.margem.toFixed(1)}%</span>
                      </div>
                      <div style={{ marginTop: 8, fontSize: 11, color: "#94A3B8", background: "#0F172A", borderRadius: 8, padding: "6px 10px" }}>
                        💡 Revise o custo ou aumente o preco deste anuncio.
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          {/* CENTRO DE INTELIGENCIA CDS */}
          <div className="dash-anim" style={{ animationDelay: "0.25s", marginBottom: 24 }}>
            <div style={{
              background: "linear-gradient(135deg, #07090F 0%, #110A00 50%, #07090F 100%)",
              border: "1px solid rgba(255,122,0,0.18)",
              borderRadius: 24, padding: "28px 32px",
              position: "relative", overflow: "hidden",
              boxShadow: "0 0 80px rgba(255,122,0,0.05), inset 0 1px 0 rgba(255,122,0,0.08)",
            }}>
              <div style={{ position:"absolute", top:-60, left:-60, width:280, height:280, borderRadius:"50%", background:"radial-gradient(circle, rgba(255,122,0,0.07) 0%, transparent 70%)", pointerEvents:"none" }} />
              <div style={{ position:"absolute", bottom:-40, right:-40, width:220, height:220, borderRadius:"50%", background:"radial-gradient(circle, rgba(99,102,241,0.06) 0%, transparent 70%)", pointerEvents:"none" }} />

              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:28 }}>
                <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                  <div style={{
                    width:46, height:46, borderRadius:14,
                    background:"linear-gradient(135deg, rgba(255,122,0,0.2), rgba(255,122,0,0.05))",
                    border:"1px solid rgba(255,122,0,0.3)",
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:22,
                    boxShadow:"0 0 20px rgba(255,122,0,0.15)",
                  }}>🧠</div>
                  <div>
                    <div style={{ fontSize:18, fontWeight:900, color:"#fff", letterSpacing:"-0.3px" }}>Centro de Inteligencia CDS</div>
                    <div style={{ fontSize:12, color:"rgba(255,122,0,0.8)", fontWeight:600 }}>Analise automatica da sua operacao • {new Date().toLocaleDateString("pt-BR")}</div>
                  </div>
                </div>
                <div style={{
                  padding:"6px 14px", borderRadius:20,
                  background:"rgba(255,122,0,0.1)", border:"1px solid rgba(255,122,0,0.2)",
                  fontSize:11, fontWeight:800, color:"#FF7A00", letterSpacing:"0.5px",
                }}>PREMIUM</div>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"220px 1fr", gap:20, marginBottom:28 }}>
                <div style={{
                  background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,122,0,0.12)",
                  borderRadius:18, padding:"20px 16px", textAlign:"center",
                }}>
                  <div style={{ fontSize:11, fontWeight:700, color:"#94A3B8", letterSpacing:"0.6px", marginBottom:12 }}>SCORE CDS</div>
                  <svg viewBox="0 0 160 100" width={160} height={100} style={{ display:"block", margin:"0 auto" }}>
                    <defs>
                      <linearGradient id="scoreGrad" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#EF4444" />
                        <stop offset="40%" stopColor="#FFB000" />
                        <stop offset="75%" stopColor="#22C55E" />
                        <stop offset="100%" stopColor="#6366F1" />
                      </linearGradient>
                    </defs>
                    <path d="M 20 85 A 60 60 0 0 1 140 85" stroke="#1E293B" strokeWidth="10" fill="none" strokeLinecap="round" />
                    {(() => {
                      const pct = score / 100;
                      const startAngle = Math.PI;
                      const endAngle = Math.PI + pct * Math.PI;
                      const x1 = 80 + 60 * Math.cos(startAngle);
                      const y1 = 85 + 60 * Math.sin(startAngle);
                      const x2 = 80 + 60 * Math.cos(endAngle);
                      const y2 = 85 + 60 * Math.sin(endAngle);
                      const large = pct > 0.5 ? 1 : 0;
                      return pct > 0.01 ? (
                        <path d={`M ${x1.toFixed(1)} ${y1.toFixed(1)} A 60 60 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`}
                          stroke="url(#scoreGrad)" strokeWidth="10" fill="none" strokeLinecap="round" />
                      ) : null;
                    })()}
                    <text x="80" y="76" textAnchor="middle" fill="#fff" fontSize="26" fontWeight="900">{score}</text>
                    <text x="80" y="90" textAnchor="middle" fill="#94A3B8" fontSize="9">
                      {score < 40 ? "Critico" : score < 70 ? "Atencao" : score < 90 ? "Saudavel" : "Excelente"}
                    </text>
                  </svg>
                  <div style={{ marginTop:10, display:"flex", justifyContent:"center", gap:8, flexWrap:"wrap" }}>
                    {[["0-39","#EF4444"],["40-69","#FFB000"],["70-89","#22C55E"],["90+","#6366F1"]].map(([l,c])=>(
                      <span key={l} style={{ fontSize:9, padding:"2px 7px", borderRadius:8, background:`${c}18`, color:c, fontWeight:700 }}>{l}</span>
                    ))}
                  </div>
                </div>

                <div style={{
                  background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,122,0,0.12)",
                  borderRadius:18, padding:"20px 24px",
                }}>
                  <div style={{ fontSize:11, fontWeight:700, color:"#94A3B8", letterSpacing:"0.6px", marginBottom:4 }}>IMPACTO FINANCEIRO ESTIMADO</div>
                  <div style={{ fontSize:12, color:"rgba(255,122,0,0.7)", marginBottom:16 }}>Se voce seguir as recomendacoes da CDS:</div>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    {[
                      { label:"Lucro adicional estimado", value:`+${fmtBRL(lucroAdicionalEstimado, true)}/mes`, color:"#22C55E", icone:"💰" },
                      { label:"Reducao de prejuizo", value:`-${fmtBRL(reducaoPrejuizo, true)}/mes`, color:"#EF4444", icone:"🛡️" },
                      { label:"Produtos a corrigir", value:`${produtosBaixaMargem.length + loss.length}`, color:"#FFB000", icone:"🔧" },
                      { label:"Margem projetada", value:`${Math.min(projetoMargem, 99).toFixed(1)}%`, color:"#6366F1", icone:"📊" },
                    ].map((item,i)=>(
                      <div key={i} style={{
                        padding:"12px 14px", borderRadius:12,
                        background:`${item.color}08`, border:`1px solid ${item.color}18`,
                      }}>
                        <div style={{ fontSize:16, marginBottom:4 }}>{item.icone}</div>
                        <div style={{ fontSize:11, color:"#94A3B8", marginBottom:3 }}>{item.label}</div>
                        <div style={{ fontSize:16, fontWeight:900, color:item.color }}>{item.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {cdsInsights.length > 0 && (
                <div style={{ marginBottom:24 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:"#94A3B8", letterSpacing:"0.6px", marginBottom:14 }}>INSIGHTS AUTOMATICOS</div>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:12 }}>
                    {cdsInsights.map((ins, i) => (
                      <div key={i} style={{
                        padding:"18px 20px",
                        background:`${ins.cor}07`,
                        border:`1px solid ${ins.cor}22`,
                        borderRadius:16, position:"relative", overflow:"hidden",
                      }}>
                        <div style={{ position:"absolute", top:-20, right:-20, width:80, height:80, borderRadius:"50%", background:`radial-gradient(circle, ${ins.cor}15 0%, transparent 70%)`, pointerEvents:"none" }} />
                        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:10 }}>
                          <span style={{ fontSize:20 }}>{ins.icone}</span>
                          <span style={{
                            fontSize:9, fontWeight:800, letterSpacing:"0.5px", padding:"3px 8px", borderRadius:8,
                            background:`${ins.cor}18`, color:ins.cor, textTransform:"uppercase",
                          }}>{ins.prioridade}</span>
                        </div>
                        <div style={{ fontSize:13, fontWeight:800, color:"#fff", marginBottom:8, lineHeight:1.4 }}>{ins.titulo}</div>
                        <div style={{ fontSize:12, color:"#94A3B8", lineHeight:1.6, marginBottom:14 }}>{ins.texto}</div>
                        <button style={{
                          padding:"6px 14px", borderRadius:8, border:`1px solid ${ins.cor}40`,
                          background:`${ins.cor}12`, color:ins.cor, fontSize:11, fontWeight:700, cursor:"pointer",
                        }}>{ins.acao} →</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {cdsAcoes.length > 0 && (
                <div>
                  <div style={{ fontSize:11, fontWeight:700, color:"#94A3B8", letterSpacing:"0.6px", marginBottom:14 }}>O QUE FAZER AGORA</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                    {cdsAcoes.map((a, i) => (
                      <div key={i} style={{
                        display:"grid", gridTemplateColumns:"auto 1fr auto auto",
                        alignItems:"center", gap:14, padding:"14px 18px",
                        background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.06)",
                        borderRadius:14,
                      }}>
                        <span style={{
                          fontSize:9, fontWeight:800, padding:"4px 9px", borderRadius:8,
                          background:`${a.cor}18`, color:a.cor, textTransform:"uppercase", whiteSpace:"nowrap",
                        }}>{a.prioridade}</span>
                        <div>
                          <div style={{ fontSize:13, fontWeight:700, color:"#fff" }}>{a.acao}</div>
                          <div style={{ fontSize:11, color:"#94A3B8", marginTop:2 }}>{a.motivo}</div>
                        </div>
                        <div style={{ textAlign:"right", whiteSpace:"nowrap" }}>
                          <div style={{ fontSize:11, color:"#94A3B8" }}>impacto</div>
                          <div style={{ fontSize:12, fontWeight:800, color:a.cor }}>{a.impacto}</div>
                        </div>
                        <button style={{
                          padding:"7px 16px", borderRadius:9, border:`1px solid ${a.cor}40`,
                          background:`${a.cor}15`, color:a.cor, fontSize:11, fontWeight:700, cursor:"pointer", whiteSpace:"nowrap",
                        }}>Agir →</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {kpis.pedidos === 0 && (
            <div style={{
              marginTop: 24, background: "#0F172A", border: "1px dashed #1E293B",
              borderRadius: 20, padding: 60, textAlign: "center",
            }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", marginBottom: 8 }}>Nenhuma venda no periodo</div>
              <div style={{ fontSize: 13, color: "#94A3B8" }}>Os dados aparecem aqui assim que houver pedidos pagos.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
