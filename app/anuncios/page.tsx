"use client";
import { useEffect, useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";
import { moeda } from "@/lib/cds-engine";
import FormAnuncio from "./FormAnuncio";
import CardAnuncio from "./CardAnuncio";

interface ResumoVendas {
  hoje: string;
  totalPedidos: number;
  faturamentoTotal: number;
  lucroTotal: number;
  itens: {
    mlItemId: string;
    nome: string;
    unidades: number;
    faturamento: number;
    lucro: number;
    cadastrado: boolean;
  }[];
}

export default function AnunciosPage() {
  const [anuncios,    setAnuncios]    = useState<Anuncio[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [editando,    setEditando]    = useState<Anuncio | null>(null);
  const [mlConectado, setMlConectado] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [resumo,        setResumo]        = useState<ResumoVendas | null>(null);
  const [erroSync,      setErroSync]      = useState("");

  async function carregar() {
    setLoading(true);
    const { data } = await supabase
      .from("anuncios")
      .select("*")
      .eq("ativo", true)
      .order("created_at", { ascending: false });
    if (data) setAnuncios(data as Anuncio[]);
    setLoading(false);
  }

  useEffect(() => {
    carregar();
    fetch("/api/auth/status")
      .then(r => r.json())
      .then(d => setMlConectado(!!d.conectado))
      .catch(() => {});
  }, []);

  async function sincronizarVendas() {
    setSincronizando(true);
    setErroSync("");
    setResumo(null);
    try {
      const res = await fetch("/api/ml/vendas-hoje");
      const data = await res.json();
      if (data.erro) {
        setErroSync(data.mensagem);
      } else {
        setResumo(data);
        await carregar();
      }
    } catch {
      setErroSync("Erro ao sincronizar. Tente novamente.");
    }
    setSincronizando(false);
  }

  async function excluir(id: string) {
    await supabase.from("anuncios").update({ ativo: false }).eq("id", id);
    setAnuncios(prev => prev.filter(a => a.id !== id));
  }

  function abrirEditar(a: Anuncio) {
    setEditando(a);
    setShowForm(true);
  }

  const totalAnuncios   = anuncios.length;
  const mediaPrecoIdeal = totalAnuncios > 0
    ? anuncios.reduce((s, a) => s + (a.preco_ideal ?? 0), 0) / totalAnuncios
    : 0;

  return (
    <div style={{ padding: "32px", maxWidth: "1280px" }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "28px", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <h1 style={{ margin: 0, fontSize: "28px", fontWeight: 900 }}>Meus Anúncios</h1>
            {totalAnuncios > 0 && (
              <span style={{ background: "rgba(255,107,0,0.15)", color: "#ff6b00", fontWeight: 800, fontSize: "13px", borderRadius: "20px", padding: "3px 12px" }}>
                {totalAnuncios}
              </span>
            )}
          </div>
          {totalAnuncios > 0 && (
            <p style={{ margin: 0, color: "#9099aa", fontSize: "14px" }}>
              Preço ideal médio:{" "}
              <span style={{ color: "#00D97E", fontWeight: 700 }}>{moeda(mediaPrecoIdeal)}</span>
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <button
            onClick={sincronizarVendas}
            disabled={sincronizando || !mlConectado}
            title={!mlConectado ? "Conecte o Mercado Livre primeiro" : "Sincronizar pedidos pagos de hoje"}
            style={{
              padding: "12px 20px",
              background: mlConectado ? "rgba(0,217,126,0.10)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${mlConectado ? "rgba(0,217,126,0.25)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: "14px",
              color: mlConectado ? "#00D97E" : "#9099aa",
              fontWeight: 800, fontSize: "14px",
              cursor: mlConectado && !sincronizando ? "pointer" : "not-allowed",
              display: "flex", alignItems: "center", gap: "7px",
              opacity: sincronizando ? 0.7 : 1,
            }}
          >
            <span>{sincronizando ? "⏳" : "🔄"}</span>
            {sincronizando ? "Sincronizando..." : "Sincronizar vendas de hoje"}
          </button>

          <button
            onClick={() => { setEditando(null); setShowForm(true); }}
            style={{
              padding: "12px 22px",
              background: "linear-gradient(135deg,#ff6b00,#ffb800)",
              border: "none", borderRadius: "14px",
              fontWeight: 900, fontSize: "14px", color: "#10131b",
              cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
            }}
          >
            + Novo Anúncio
          </button>
        </div>
      </div>

      {/* ── Aviso ML desconectado ──────────────────────────────── */}
      {!mlConectado && (
        <div style={{
          background: "rgba(255,180,0,0.06)", border: "1px solid rgba(255,180,0,0.18)",
          borderRadius: "16px", padding: "14px 18px", marginBottom: "24px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "20px" }}>⚡</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: "14px", color: "#ffb800" }}>Mercado Livre não conectado</div>
              <div style={{ color: "#9099aa", fontSize: "13px" }}>Conecte para sincronizar vendas e buscar anúncios pelo link automaticamente.</div>
            </div>
          </div>
          <a href="/api/auth/mercadolivre" style={{
            padding: "10px 18px", textDecoration: "none",
            background: "#FFE600", borderRadius: "12px",
            fontWeight: 900, color: "#10131b", fontSize: "13px", whiteSpace: "nowrap",
          }}>
            Conectar ML
          </a>
        </div>
      )}

      {/* ── Erro sincronização ─────────────────────────────────── */}
      {erroSync && (
        <div style={{ background: "rgba(255,60,60,0.07)", border: "1px solid rgba(255,60,60,0.18)", borderRadius: "16px", padding: "14px 18px", marginBottom: "20px", color: "#ff4d4d", fontSize: "14px" }}>
          ⚠️ {erroSync}
        </div>
      )}

      {/* ── Painel resultado do dia ────────────────────────────── */}
      {resumo && (
        <div style={{ background: "rgba(0,217,126,0.04)", border: "1px solid rgba(0,217,126,0.18)", borderRadius: "20px", padding: "20px", marginBottom: "28px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: "16px", marginBottom: "2px" }}>📊 Resultado de hoje — {resumo.hoje}</div>
              <div style={{ color: "#9099aa", fontSize: "13px" }}>{resumo.totalPedidos} pedido{resumo.totalPedidos !== 1 ? "s" : ""} sincronizado{resumo.totalPedidos !== 1 ? "s" : ""}</div>
            </div>
            <div style={{ display: "flex", gap: "24px" }}>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#9099aa", fontSize: "11px", fontWeight: 700 }}>FATURAMENTO</div>
                <div style={{ fontSize: "22px", fontWeight: 900 }}>{moeda(resumo.faturamentoTotal)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: "#9099aa", fontSize: "11px", fontWeight: 700 }}>LUCRO ESTIMADO</div>
                <div style={{ fontSize: "22px", fontWeight: 900, color: "#00D97E" }}>{moeda(resumo.lucroTotal)}</div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {resumo.itens.map(item => (
              <div key={item.mlItemId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                background: "rgba(255,255,255,0.04)", borderRadius: "12px", padding: "10px 14px",
                gap: "12px", flexWrap: "wrap",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1, minWidth: 0 }}>
                  <span>{item.cadastrado ? "✅" : "⚠️"}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.nome}</div>
                    <div style={{ color: "#9099aa", fontSize: "11px", fontFamily: "monospace" }}>{item.mlItemId}</div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "20px", flexShrink: 0 }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#9099aa", fontSize: "10px", fontWeight: 700 }}>UNID.</div>
                    <div style={{ fontWeight: 800 }}>{item.unidades}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#9099aa", fontSize: "10px", fontWeight: 700 }}>FATURAMENTO</div>
                    <div style={{ fontWeight: 800 }}>{moeda(item.faturamento)}</div>
                  </div>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ color: "#9099aa", fontSize: "10px", fontWeight: 700 }}>LUCRO</div>
                    <div style={{ fontWeight: 800, color: item.cadastrado ? "#00D97E" : "#9099aa" }}>
                      {item.cadastrado ? moeda(item.lucro) : "—"}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {resumo.itens.some(i => !i.cadastrado) && (
              <p style={{ color: "#9099aa", fontSize: "12px", margin: "4px 0 0" }}>
                ⚠️ Itens marcados com ⚠️ foram vendidos mas não estão cadastrados. Adicione-os para ver o lucro.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Modal ──────────────────────────────────────────────── */}
      {showForm && (
        <FormAnuncio
          inicial={editando}
          onSalvar={() => { setShowForm(false); carregar(); }}
          onFechar={() => setShowForm(false)}
        />
      )}

      {/* ── Grid de anúncios ───────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "60px", color: "#9099aa" }}>Carregando...</div>
      ) : anuncios.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 20px", border: "2px dashed rgba(255,255,255,0.08)", borderRadius: "24px", color: "#9099aa" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>📦</div>
          <p style={{ fontSize: "18px", fontWeight: 700, color: "#d7dbe5", margin: "0 0 8px" }}>Nenhum anúncio cadastrado ainda</p>
          <p style={{ margin: 0 }}>Clique em "+ Novo Anúncio" e cole o link do seu produto no ML</p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "18px" }}>
          {anuncios.map(a => (
            <CardAnuncio
              key={a.id}
              anuncio={a}
              onEditar={() => abrirEditar(a)}
              onExcluir={() => excluir(a.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
