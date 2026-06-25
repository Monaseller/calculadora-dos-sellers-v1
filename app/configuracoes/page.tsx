"use client";
import { useEffect, useState } from "react";

type Loja = {
  id: string;
  nome: string;
  marketplace: string;
  seller_id: string | null;
  nickname: string | null;
  ativo: boolean;
  created_at: string;
};

function LojaCard({ loja, ativa, onAtivar, onDesconectar }: {
  loja: Loja;
  ativa: boolean;
  onAtivar: () => void;
  onDesconectar: () => void;
}) {
  const [confirmando, setConfirmando] = useState(false);

  const isML = loja.marketplace === "ML";
  const cor  = isML ? "#FFE000" : "#EE4D2D";
  const bgCor = isML ? "rgba(255,224,0,0.08)" : "rgba(238,77,45,0.08)";

  return (
    <div style={{
      background: ativa ? "rgba(100,160,255,0.07)" : "rgba(255,255,255,0.03)",
      border: `1px solid ${ativa ? "rgba(100,160,255,0.35)" : "rgba(255,255,255,0.08)"}`,
      borderRadius: "14px",
      padding: "20px 24px",
      display: "flex",
      alignItems: "center",
      gap: "20px",
    }}>
      {/* Ícone marketplace */}
      <div style={{
        width: "48px", height: "48px", borderRadius: "12px",
        background: bgCor, border: `1px solid ${cor}33`,
        display: "grid", placeItems: "center", flexShrink: 0,
        fontSize: "22px",
      }}>
        {isML ? "🛒" : "🛍️"}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
          <span style={{ fontWeight: 800, fontSize: "15px", color: "#fff" }}>
            {loja.nickname || loja.nome}
          </span>
          <span style={{
            fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px",
            background: bgCor, color: cor, border: `1px solid ${cor}44`,
          }}>
            {loja.marketplace}
          </span>
          {ativa && (
            <span style={{
              fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "6px",
              background: "rgba(0,217,126,0.12)", color: "#00D97E", border: "1px solid rgba(0,217,126,0.3)",
            }}>
              ● Ativa
            </span>
          )}
        </div>
        <div style={{ fontSize: "12px", color: "#9099aa" }}>
          ID: {loja.seller_id ?? "—"} · Conectada em {new Date(loja.created_at).toLocaleDateString("pt-BR")}
        </div>
      </div>

      {/* Ações */}
      <div style={{ display: "flex", gap: "10px", flexShrink: 0 }}>
        {!ativa && (
          <button
            onClick={onAtivar}
            style={{
              padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(100,160,255,0.4)",
              background: "rgba(100,160,255,0.1)", color: "#6fa3ff", fontWeight: 700,
              fontSize: "13px", cursor: "pointer",
            }}
          >
            Usar esta
          </button>
        )}

        {!confirmando ? (
          <button
            onClick={() => setConfirmando(true)}
            style={{
              padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(255,80,80,0.3)",
              background: "rgba(255,80,80,0.08)", color: "#ff6b6b", fontWeight: 700,
              fontSize: "13px", cursor: "pointer",
            }}
          >
            Desconectar
          </button>
        ) : (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => setConfirmando(false)}
              style={{ padding: "8px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "#9099aa", fontWeight: 700, fontSize: "13px", cursor: "pointer" }}
            >
              Cancelar
            </button>
            <button
              onClick={onDesconectar}
              style={{ padding: "8px 14px", borderRadius: "8px", border: "none", background: "#ff4444", color: "#fff", fontWeight: 700, fontSize: "13px", cursor: "pointer" }}
            >
              Confirmar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ConfiguracoesPage() {
  const [lojas,     setLojas]     = useState<Loja[]>([]);
  const [lojaAtiva, setLojaAtiva] = useState<string | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [msg,       setMsg]       = useState<{ ok: boolean; texto: string } | null>(null);

  function getCookieClient(name: string): string | null {
    if (typeof document === "undefined") return null;
    const entry = document.cookie.split("; ").find(c => c.startsWith(`${name}=`));
    return entry ? entry.slice(name.length + 1) : null;
  }

  async function carregarLojas() {
    setLoading(true);
    try {
      const res = await fetch("/api/lojas");
      const data = await res.json();
      setLojas(Array.isArray(data) ? data : []);
    } catch {}
    setLojaAtiva(getCookieClient("loja_ativa_id"));
    setLoading(false);
  }

  useEffect(() => { carregarLojas(); }, []);

  async function ativarLoja(id: string) {
    const res = await fetch("/api/lojas/ativar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loja_id: id }),
    });
    if (res.ok) {
      setLojaAtiva(id);
      mostrarMsg(true, "Loja ativada com sucesso!");
    }
  }

  async function desconectarLoja(id: string) {
    const res = await fetch("/api/lojas/desconectar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loja_id: id }),
    });
    if (res.ok) {
      await carregarLojas();
      mostrarMsg(true, "Loja desconectada.");
    }
  }

  function mostrarMsg(ok: boolean, texto: string) {
    setMsg({ ok, texto });
    setTimeout(() => setMsg(null), 3500);
  }

  const conectarML = () => { window.location.href = "/api/auth/mercadolivre"; };

  return (
    <div style={{ padding: "32px", maxWidth: "860px", margin: "0 auto" }}>

      {/* Toast */}
      {msg && (
        <div style={{
          position: "fixed", top: "24px", right: "24px", zIndex: 9999,
          background: msg.ok ? "rgba(0,217,126,0.15)" : "rgba(255,80,80,0.15)",
          border: `1px solid ${msg.ok ? "rgba(0,217,126,0.4)" : "rgba(255,80,80,0.4)"}`,
          color: msg.ok ? "#00D97E" : "#ff6b6b",
          padding: "12px 20px", borderRadius: "10px", fontWeight: 700, fontSize: "14px",
        }}>
          {msg.texto}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: "36px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 900, color: "#fff", margin: 0 }}>Configurações</h1>
        <p style={{ fontSize: "14px", color: "#9099aa", marginTop: "6px" }}>
          Gerencie suas lojas e conexões com marketplaces.
        </p>
      </div>

      {/* Seção lojas */}
      <section style={{ marginBottom: "40px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#fff", margin: 0 }}>Minhas lojas</h2>
            <p style={{ fontSize: "12px", color: "#9099aa", marginTop: "4px" }}>
              Conecte múltiplas contas de marketplace.
            </p>
          </div>
        </div>

        {loading ? (
          <div style={{ color: "#9099aa", fontSize: "14px" }}>Carregando...</div>
        ) : lojas.length === 0 ? (
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: "14px", padding: "40px", textAlign: "center", color: "#9099aa",
          }}>
            <div style={{ fontSize: "36px", marginBottom: "12px" }}>🏪</div>
            <div style={{ fontWeight: 700, fontSize: "15px", color: "#fff", marginBottom: "8px" }}>
              Nenhuma loja conectada
            </div>
            <div style={{ fontSize: "13px" }}>Conecte sua primeira loja abaixo.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {lojas.map(l => (
              <LojaCard
                key={l.id}
                loja={l}
                ativa={lojaAtiva === l.id}
                onAtivar={() => ativarLoja(l.id)}
                onDesconectar={() => desconectarLoja(l.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Adicionar lojas */}
      <section>
        <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#fff", margin: "0 0 16px" }}>
          Conectar nova loja
        </h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: "14px" }}>

          {/* ML */}
          <button
            onClick={conectarML}
            style={{
              background: "rgba(255,224,0,0.06)", border: "1px solid rgba(255,224,0,0.2)",
              borderRadius: "14px", padding: "24px", cursor: "pointer", textAlign: "left",
              transition: "background 0.2s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,224,0,0.12)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,224,0,0.06)")}
          >
            <div style={{ fontSize: "28px", marginBottom: "12px" }}>🛒</div>
            <div style={{ fontWeight: 800, fontSize: "15px", color: "#FFE000", marginBottom: "4px" }}>
              Mercado Livre
            </div>
            <div style={{ fontSize: "12px", color: "#9099aa", lineHeight: 1.5 }}>
              Conecte via OAuth. Suporte a múltiplas contas.
            </div>
            <div style={{
              marginTop: "16px", display: "inline-flex", alignItems: "center", gap: "6px",
              background: "rgba(255,224,0,0.15)", border: "1px solid rgba(255,224,0,0.3)",
              padding: "6px 14px", borderRadius: "8px", color: "#FFE000", fontWeight: 700, fontSize: "12px",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
              </svg>
              Conectar
            </div>
          </button>

          {/* Shopee — em breve */}
          <div style={{
            background: "rgba(238,77,45,0.04)", border: "1px solid rgba(238,77,45,0.12)",
            borderRadius: "14px", padding: "24px", opacity: 0.55, position: "relative",
          }}>
            <div style={{
              position: "absolute", top: "12px", right: "12px",
              background: "rgba(255,255,255,0.08)", borderRadius: "6px",
              padding: "2px 8px", fontSize: "10px", color: "#9099aa", fontWeight: 700,
            }}>
              EM BREVE
            </div>
            <div style={{ fontSize: "28px", marginBottom: "12px" }}>🛍️</div>
            <div style={{ fontWeight: 800, fontSize: "15px", color: "#EE4D2D", marginBottom: "4px" }}>
              Shopee
            </div>
            <div style={{ fontSize: "12px", color: "#9099aa", lineHeight: 1.5 }}>
              Integração via API Shopee Open Platform.
            </div>
          </div>

        </div>
      </section>

    </div>
  );
}
