"use client";
import { useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";

interface Props {
  anuncio: Anuncio;
  onEditar: () => void;
  onExcluir: () => void;
}

const moeda = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

export default function CardAnuncio({ anuncio: a, onEditar, onExcluir }: Props) {
  const [vendas,    setVendas]    = useState("");
  const [resultado, setResultado] = useState<{ faturamento: number; lucro: number; custos: number } | null>(null);
  const [salvando,  setSalvando]  = useState(false);

  const COR   = a.marketplace === "ML" ? "#FFE600" : "#EE4D2D";
  const CORBG = a.marketplace === "ML" ? "rgba(255,230,0,0.12)" : "rgba(238,77,45,0.12)";

  // Diferença preço atual vs ideal
  const precoAtual = (a as any).preco_anuncio as number | null;
  const precoIdeal = a.preco_ideal;
  let statusPreco: "ok" | "baixo" | null = null;
  if (precoAtual && precoIdeal) {
    statusPreco = precoAtual >= precoIdeal ? "ok" : "baixo";
  }

  function calcular() {
    const u = Number(vendas) || 0;
    if (!u || !precoIdeal) return;
    const faturamento = precoIdeal * u;
    const custoTotal  = (a.custo_produto + a.insumos + a.custo_frete) * u;
    const lucro       = faturamento * (a.margem_desejada / 100);
    setResultado({ faturamento, lucro, custos: custoTotal });
  }

  async function salvarVendaDia() {
    const u = Number(vendas) || 0;
    if (!u || !resultado) return;
    setSalvando(true);
    await supabase.from("vendas_dia").upsert({
      anuncio_id: a.id,
      data: new Date().toISOString().split("T")[0],
      unidades_vendidas: u,
      faturamento: resultado.faturamento,
      lucro: resultado.lucro,
    }, { onConflict: "anuncio_id,data" });
    setSalvando(false);
    setVendas("");
    setResultado(null);
  }

  return (
    <div style={{
      background: "#0d1118",
      border: `1px solid rgba(255,255,255,0.07)`,
      borderTop: `3px solid ${COR}`,
      borderRadius: "22px",
      display: "flex", flexDirection: "column",
      overflow: "hidden",
    }}>
      {/* ── Top: imagem + info ─────────────────────────────────── */}
      <div style={{ display: "flex", gap: "14px", padding: "18px 18px 14px" }}>
        {/* Thumbnail */}
        {(a as any).thumbnail ? (
          <img
            src={(a as any).thumbnail.replace("http://", "https://")}
            alt=""
            style={{ width: "64px", height: "64px", objectFit: "contain", borderRadius: "12px", background: "#fff", flexShrink: 0 }}
          />
        ) : (
          <div style={{ width: "64px", height: "64px", borderRadius: "12px", background: "rgba(255,255,255,0.06)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "26px" }}>
            📦
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Badge marketplace */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "5px", flexWrap: "wrap" }}>
            <span style={{ background: CORBG, color: COR, fontSize: "10px", fontWeight: 800, borderRadius: "6px", padding: "2px 8px", letterSpacing: "0.3px" }}>
              {a.marketplace}{a.tipo_anuncio ? ` · ${a.tipo_anuncio}` : ""}
            </span>
            {(a as any).ml_item_id && (
              <span style={{ background: "rgba(255,255,255,0.06)", color: "#9099aa", fontSize: "10px", fontWeight: 700, borderRadius: "6px", padding: "2px 8px", fontFamily: "monospace" }}>
                {(a as any).ml_item_id}
              </span>
            )}
          </div>

          {/* Nome */}
          <div style={{ fontWeight: 800, fontSize: "14px", lineHeight: 1.3, marginBottom: "3px" }}>
            {a.nome}
          </div>
          {a.categoria && (
            <div style={{ color: "#9099aa", fontSize: "11px" }}>{a.categoria}</div>
          )}
        </div>

        {/* Ações */}
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          <button onClick={onEditar} title="Editar" style={{ background: "rgba(255,255,255,0.06)", border: "none", borderRadius: "8px", padding: "7px 9px", color: "#9099aa", cursor: "pointer", fontSize: "14px" }}>✏️</button>
          <button onClick={() => { if (confirm("Excluir este anúncio?")) onExcluir(); }} title="Excluir" style={{ background: "rgba(255,60,60,0.1)", border: "none", borderRadius: "8px", padding: "7px 9px", color: "#ff4d4d", cursor: "pointer", fontSize: "14px" }}>🗑</button>
        </div>
      </div>

      {/* ── Preços ────────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: precoAtual ? "1fr 1fr" : "1fr", gap: "1px", margin: "0 18px 14px", background: "rgba(255,255,255,0.06)", borderRadius: "14px", overflow: "hidden" }}>
        <div style={{ background: "#0d1118", padding: "12px 14px" }}>
          <div style={{ color: "#9099aa", fontSize: "10px", fontWeight: 700, marginBottom: "3px" }}>PREÇO IDEAL</div>
          <div style={{ fontSize: "22px", fontWeight: 900, color: "#00D97E" }}>
            {precoIdeal ? moeda(precoIdeal) : <span style={{ color: "#9099aa", fontSize: "16px" }}>—</span>}
          </div>
          <div style={{ color: "#9099aa", fontSize: "10px", marginTop: "2px" }}>margem {a.margem_desejada}%</div>
        </div>
        {precoAtual && (
          <div style={{ background: "#0d1118", padding: "12px 14px" }}>
            <div style={{ color: "#9099aa", fontSize: "10px", fontWeight: 700, marginBottom: "3px" }}>PREÇO ATUAL ML</div>
            <div style={{ fontSize: "22px", fontWeight: 900, color: statusPreco === "ok" ? "#00D97E" : "#ff4d4d" }}>
              {moeda(precoAtual)}
            </div>
            <div style={{ fontSize: "10px", marginTop: "2px", color: statusPreco === "ok" ? "#00D97E" : "#ff4d4d", fontWeight: 700 }}>
              {statusPreco === "ok" ? "✓ Acima do ideal" : "⚠️ Abaixo do ideal"}
            </div>
          </div>
        )}
      </div>

      {/* ── Custos resumo ──────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "6px", padding: "0 18px 14px" }}>
        {[
          { label: "Produto",  val: moeda(a.custo_produto) },
          { label: "Imposto",  val: `${a.imposto}%` },
          { label: "Frete",    val: a.frete_gratis ? "Grátis" : moeda(a.custo_frete) },
        ].map(({ label, val }) => (
          <div key={label} style={{ flex: 1, background: "rgba(255,255,255,0.04)", borderRadius: "10px", padding: "8px", textAlign: "center" }}>
            <div style={{ fontSize: "9px", color: "#9099aa", fontWeight: 700, marginBottom: "2px" }}>{label.toUpperCase()}</div>
            <div style={{ fontSize: "12px", fontWeight: 800 }}>{val}</div>
          </div>
        ))}
      </div>

      {/* ── Vendas do dia ──────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", padding: "14px 18px 18px" }}>
        <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, marginBottom: "10px", letterSpacing: "0.5px" }}>
          📊 VENDAS DE HOJE
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="number" min="0"
            value={vendas}
            onChange={e => { setVendas(e.target.value); setResultado(null); }}
            placeholder="Qtd vendida"
            style={{
              flex: 1, padding: "10px 13px", borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.1)",
              background: "rgba(255,255,255,0.05)",
              color: "white", fontSize: "14px", outline: "none",
            }}
          />
          <button onClick={calcular} style={{
            padding: "10px 14px", whiteSpace: "nowrap",
            background: "linear-gradient(135deg,#ff6b00,#ffb800)",
            border: "none", borderRadius: "10px",
            fontWeight: 800, color: "#10131b", cursor: "pointer", fontSize: "13px",
          }}>Ver P&L</button>
        </div>

        {resultado && (
          <div style={{ marginTop: "12px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#9099aa" }}>Faturamento</span>
                <span style={{ fontWeight: 800 }}>{moeda(resultado.faturamento)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                <span style={{ color: "#9099aa" }}>Custos diretos</span>
                <span style={{ fontWeight: 800, color: "#ff4d4d" }}>-{moeda(resultado.custos)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontWeight: 700, fontSize: "14px" }}>💚 Lucro estimado</span>
                <span style={{ fontWeight: 900, fontSize: "17px", color: "#00D97E" }}>{moeda(resultado.lucro)}</span>
              </div>
            </div>
            <button onClick={salvarVendaDia} disabled={salvando} style={{
              width: "100%", padding: "9px",
              background: "rgba(0,217,126,0.12)",
              border: "1px solid rgba(0,217,126,0.25)",
              borderRadius: "10px", color: "#00D97E",
              fontWeight: 800, cursor: "pointer", fontSize: "12px",
            }}>
              {salvando ? "Salvando..." : "💾 Salvar vendas do dia"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
