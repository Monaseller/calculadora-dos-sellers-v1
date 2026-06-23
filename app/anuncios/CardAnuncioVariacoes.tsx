"use client";
import { type Anuncio } from "@/lib/supabase";
import { CATEGORIAS_ML } from "@/lib/comissoes-mercado-livre";

interface Props {
  variacoes: Anuncio[];
  onEditar: (a: Anuncio) => void;
  onExcluir: (id: string) => void;
}

const moeda = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

const CORES_VAR = ["#6fa3ff", "#00D97E", "#ffb800", "#c084fc", "#ff6b6b", "#38bdf8"];

function calcVariacao(a: Anuncio) {
  if (!a.preco_anuncio) return null;
  const cat = CATEGORIAS_ML.find(c => c.nome.toLowerCase() === (a.categoria ?? "").toLowerCase());
  const comissao = a.tipo_anuncio === "Premium" ? (cat?.premium ?? 0.18) : (cat?.classico ?? 0.13);
  const comissaoVal = a.preco_anuncio * comissao;
  const impostoVal  = a.preco_anuncio * ((a.imposto || 0) / 100);
  const freteVal    = a.custo_frete; // sempre inclui custo frete (mesmo se gratis ao comprador)
  const lucro       = a.preco_anuncio - comissaoVal - impostoVal - freteVal - a.custo_produto - a.insumos;
  return { lucro, margem: (lucro / a.preco_anuncio) * 100 };
}

export default function CardAnuncioVariacoes({ variacoes, onEditar, onExcluir }: Props) {
  const primeiro = variacoes[0];
  // Título base: tudo antes do primeiro " — " no nome
  const nomeBase = primeiro.nome?.includes(" — ")
    ? primeiro.nome.split(" — ")[0]
    : primeiro.nome ?? "Produto";
  // Thumbnail: primeiro que tiver
  const thumbnail = variacoes.find(v => v.thumbnail)?.thumbnail ?? null;

  return (
    <div style={{
      background: "#0d1118",
      border: "1px solid rgba(255,255,255,0.07)",
      borderTop: "3px solid #FFE600",
      borderRadius: "22px",
      overflow: "hidden",
    }}>
      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "14px", padding: "18px 18px 14px", alignItems: "flex-start" }}>
        {thumbnail ? (
          <img
            src={thumbnail.replace("http://", "https://")}
            alt=""
            style={{
              width: "58px", height: "58px", objectFit: "contain",
              borderRadius: "12px", background: "#fff", flexShrink: 0,
            }}
          />
        ) : (
          <div style={{
            width: "58px", height: "58px", borderRadius: "12px",
            background: "rgba(255,255,255,0.06)", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px",
          }}>📦</div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Badges */}
          <div style={{ display: "flex", gap: "6px", marginBottom: "5px", flexWrap: "wrap" }}>
            <span style={{
              background: "rgba(255,230,0,0.12)", color: "#FFE600",
              fontSize: "10px", fontWeight: 800, borderRadius: "6px", padding: "2px 8px",
            }}>
              ML{primeiro.tipo_anuncio ? ` · ${primeiro.tipo_anuncio}` : ""}
            </span>
            <span style={{
              background: "rgba(100,160,255,0.1)", color: "#6fa3ff",
              fontSize: "10px", fontWeight: 800, borderRadius: "6px", padding: "2px 8px",
            }}>
              {variacoes.length} variações
            </span>
            {primeiro.ml_item_id && (
              <span style={{
                background: "rgba(255,255,255,0.06)", color: "#9099aa",
                fontSize: "10px", fontWeight: 700, borderRadius: "6px", padding: "2px 8px",
                fontFamily: "monospace",
              }}>
                {primeiro.ml_item_id}
              </span>
            )}
          </div>
          {/* Nome */}
          <div style={{
            fontWeight: 800, fontSize: "14px", lineHeight: 1.3,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {nomeBase}
          </div>
          {primeiro.categoria && (
            <div style={{ color: "#9099aa", fontSize: "11px", marginTop: "2px" }}>
              {primeiro.categoria}
            </div>
          )}
        </div>
      </div>

      {/* ── Separador ──────────────────────────────────────────── */}
      <div style={{ height: "1px", background: "rgba(255,255,255,0.06)", margin: "0 18px" }} />

      {/* ── Variações ──────────────────────────────────────────── */}
      <div style={{ padding: "10px 14px 16px", display: "flex", flexDirection: "column", gap: "7px" }}>
        <div style={{
          fontSize: "9px", fontWeight: 700, color: "#9099aa",
          letterSpacing: "0.5px", margin: "4px 4px 2px",
        }}>
          VARIAÇÕES
        </div>

        {variacoes.map((v, idx) => {
          // Parte do nome após " — " é o label da variação
          const varLabel = v.nome?.includes(" — ")
            ? v.nome.split(" — ").slice(1).join(" — ")
            : v.nome ?? "";
          const calc = calcVariacao(v);
          const cor  = CORES_VAR[idx % CORES_VAR.length];

          return (
            <div
              key={v.id}
              style={{
                display: "flex", alignItems: "center", gap: "10px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderLeft: `3px solid ${cor}`,
                borderRadius: "12px",
                padding: "9px 11px",
              }}
            >
              {/* Thumbnail da variação */}
              {v.thumbnail ? (
                <img
                  src={v.thumbnail.replace("http://", "https://")}
                  alt=""
                  style={{
                    width: "34px", height: "34px", objectFit: "contain",
                    borderRadius: "8px", background: "#fff", flexShrink: 0,
                  }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              ) : (
                <div style={{
                  width: "34px", height: "34px", borderRadius: "8px",
                  background: "rgba(255,255,255,0.06)", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px",
                }}>📦</div>
              )}

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: "12px", fontWeight: 700, color: "#d7dbe5",
                  lineHeight: 1.3,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {varLabel}
                </div>
                {v.sku && (
                  <div style={{ fontSize: "10px", color: "#9099aa", fontFamily: "monospace", marginTop: "1px" }}>
                    SKU: {v.sku}
                  </div>
                )}
              </div>

              {/* Preço + margem */}
              <div style={{ textAlign: "right", flexShrink: 0, marginRight: "4px" }}>
                <div style={{ fontSize: "14px", fontWeight: 900 }}>
                  {v.preco_anuncio ? moeda(v.preco_anuncio) : "—"}
                </div>
                {calc && (
                  <div style={{
                    fontSize: "11px", fontWeight: 700, marginTop: "1px",
                    color: calc.lucro >= 0 ? "#00D97E" : "#ff4d4d",
                  }}>
                    {calc.margem.toFixed(1)}%
                  </div>
                )}
              </div>

              {/* Ações */}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px", flexShrink: 0 }}>
                <button
                  onClick={() => onEditar(v)}
                  title="Editar variação"
                  style={{
                    background: "rgba(255,255,255,0.07)", border: "none",
                    borderRadius: "7px", padding: "5px 7px",
                    color: "#9099aa", cursor: "pointer", fontSize: "12px",
                    lineHeight: 1,
                  }}
                >
                  ✏️
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Excluir variação "${varLabel}"?`)) onExcluir(v.id);
                  }}
                  title="Excluir variação"
                  style={{
                    background: "rgba(255,60,60,0.1)", border: "none",
                    borderRadius: "7px", padding: "5px 7px",
                    color: "#ff4d4d", cursor: "pointer", fontSize: "12px",
                    lineHeight: 1,
                  }}
                >
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
