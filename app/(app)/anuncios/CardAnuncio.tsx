"use client";
import { useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";

interface Props {
  anuncio: Anuncio;
  onEditar: () => void;
  onExcluir: () => void;
}

const moeda = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

export default function CardAnuncio({ anuncio: a, onEditar, onExcluir }: Props) {
  const [vendas,    setVendas]    = useState("");
  const [resultado, setResultado] = useState<{
    faturamento: number;
    lucro: number;
    comissao: number;
    imposto: number;
    frete: number;
    custoProduto: number;
    insumos: number;
  } | null>(null);
  const [salvando,  setSalvando]  = useState(false);

  const COR   = a.marketplace === "ML" ? "#FFE600" : "#EE4D2D";
  const CORBG = a.marketplace === "ML" ? "rgba(255,230,0,0.12)" : "rgba(238,77,45,0.12)";

  const precoAtual = a.preco_anuncio;

  // Calcula lucro e margem dinamicamente — não depende de colunas extras no DB
  function calcLucroMargem() {
    if (!precoAtual) return null;
    const cat = CATEGORIAS_ML.find(c => c.nome.toLowerCase() === (a.categoria ?? "").toLowerCase());
    // Usa taxa padrão quando categoria não é encontrada (subcategorias do ML não mapeadas)
    const comissao    = a.marketplace === "ML"
      ? (a.tipo_anuncio === "Premium" ? (cat?.premium ?? 0.18) : (cat?.classico ?? 0.13))
      : 0.12;
    const comissaoVal = precoAtual * comissao;
    const impostoVal  = precoAtual * ((a.imposto || 0) / 100);
    const freteVal    = a.frete_gratis ? 0 : a.custo_frete;
    const lucro       = precoAtual - comissaoVal - impostoVal - freteVal - a.custo_produto - a.insumos;
    return { lucro, margem: (lucro / precoAtual) * 100, comissaoVal, impostoVal, freteVal };
  }

  const calc      = calcLucroMargem();
  const lucroUnit = calc?.lucro ?? null;
  const margemReal = calc?.margem ?? null;

  function calcular() {
    const u = Number(vendas) || 0;
    if (!u || !precoAtual || !calc) return;
    setResultado({
      faturamento:  precoAtual       * u,
      lucro:        calc.lucro       * u,
      comissao:     calc.comissaoVal * u,
      imposto:      calc.impostoVal  * u,
      frete:        calc.freteVal    * u,
      custoProduto: a.custo_produto  * u,
      insumos:      a.insumos        * u,
    });
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
            {a.ml_item_id && (
              <span style={{ background: "rgba(255,255,255,0.06)", color: "#9099aa", fontSize: "10px", fontWeight: 700, borderRadius: "6px", padding: "2px 8px", fontFamily: "monospace" }}>
                {a.ml_item_id}
              </span>
            )}
            {a.sku && (
              <span style={{ background: "rgba(255,255,255,0.06)", color: "#9099aa", fontSize: "10px", fontWeight: 700, borderRadius: "6px", padding: "2px 8px", fontFamily: "monospace" }}>
                SKU: {a.sku}
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

      {/* ── Preços / Resultado ──────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1px", margin: "0 18px 14px", background: "rgba(255,255,255,0.06)", borderRadius: "14px", overflow: "hidden" }}>
        <div style={{ background: "#0d1118", padding: "12px 10px" }}>
          <div style={{ color: "#9099aa", fontSize: "9px", fontWeight: 700, marginBottom: "3px" }}>PREÇO ATUAL</div>
          <div style={{ fontSize: "17px", fontWeight: 900 }}>
            {precoAtual ? moeda(precoAtual) : <span style={{ color: "#9099aa", fontSize: "14px" }}>—</span>}
          </div>
          <div style={{ color: "#9099aa", fontSize: "9px", marginTop: "2px" }}>
            {a.frete_gratis ? "🚚 frete grátis" : "📦 frete comprador"}
          </div>
        </div>
        <div style={{ background: "#0d1118", padding: "12px 10px" }}>
          <div style={{ color: "#9099aa", fontSize: "9px", fontWeight: 700, marginBottom: "3px" }}>LUCRO LÍQUIDO</div>
          <div style={{ fontSize: "17px", fontWeight: 900, color: lucroUnit != null ? (lucroUnit >= 0 ? "#00D97E" : "#ff4d4d") : "#9099aa" }}>
            {lucroUnit != null ? moeda(lucroUnit) : <span style={{ fontSize: "14px" }}>—</span>}
          </div>
          <div style={{ color: "#9099aa", fontSize: "9px", marginTop: "2px" }}>por unidade</div>
        </div>
        <div style={{ background: "#0d1118", padding: "12px 10px" }}>
          <div style={{ color: "#9099aa", fontSize: "9px", fontWeight: 700, marginBottom: "3px" }}>MARGEM</div>
          <div style={{ fontSize: "17px", fontWeight: 900, color: margemReal != null ? (margemReal >= 0 ? "#00D97E" : "#ff4d4d") : "#9099aa" }}>
            {margemReal != null ? `${margemReal.toFixed(1)}%` : <span style={{ fontSize: "14px" }}>—</span>}
          </div>
          <div style={{ color: "#9099aa", fontSize: "9px", marginTop: "2px" }}>contribuição</div>
        </div>
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
            <div style={{ display: "flex", flexDirection: "column", gap: "5px", marginBottom: "10px" }}>
              {/* Faturamento */}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontWeight: 700 }}>Faturamento</span>
                <span style={{ fontWeight: 800 }}>{moeda(resultado.faturamento)}</span>
              </div>
              {/* Deduções */}
              {[
                { label: "Comissão ML",            val: resultado.comissao },
                { label: `Imposto (${a.imposto}%)`, val: resultado.imposto },
                { label: "Custo produto",           val: resultado.custoProduto },
                { label: "Insumos",                 val: resultado.insumos },
                ...(!a.frete_gratis && resultado.frete > 0 ? [{ label: "Frete", val: resultado.frete }] : []),
              ].filter(i => i.val > 0).map(({ label, val }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                  <span style={{ color: "#9099aa" }}>{label}</span>
                  <span style={{ fontWeight: 700, color: "#ff6b6b" }}>-{moeda(val)}</span>
                </div>
              ))}
              {/* Lucro líquido */}
              <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <span style={{ fontWeight: 700, fontSize: "14px" }}>💚 Lucro líquido</span>
                <span style={{ fontWeight: 900, fontSize: "17px", color: resultado.lucro >= 0 ? "#00D97E" : "#ff4d4d" }}>{moeda(resultado.lucro)}</span>
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
