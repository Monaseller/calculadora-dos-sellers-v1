"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
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

  const conectarML = () => router.push("/api/auth/mercadolivre");

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
          Gerencie suas contas e conexões com marketplaces.
        </p>
      </div>

      {/* ── Minhas contas ── */}
      <section style={{ marginBottom: "40px" }}>
        <div style={{ marginBottom: "16px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#fff", margin: 0 }}>Minhas contas</h2>
          <p style={{ fontSize: "12px", color: "#9099aa", marginTop: "4px" }}>
            {lojas.length} conta{lojas.length !== 1 ? "s" : ""} conectada{lojas.length !== 1 ? "s" : ""}.
            Clique em "Usar esta" para alternar a conta ativa.
          </p>
        </div>

        {loading ? (
          <div style={{ color: "#9099aa", fontSize: "14px", padding: "20px 0" }}>Carregando...</div>
        ) : lojas.length === 0 ? (
          <div style={{
            background: "rgba(255,255,255,0.03)", border: "1px dashed rgba(255,255,255,0.1)",
            borderRadius: "14px", padding: "48px", textAlign: "center", color: "#9099aa",
          }}>
            <div style={{ fontSize: "40px", marginBottom: "14px" }}>🏪</div>
            <div style={{ fontWeight: 700, fontSize: "15px", color: "#fff", marginBottom: "8px" }}>
              Nenhuma conta conectada
            </div>
            <div style={{ fontSize: "13px", marginBottom: "20px" }}>
              Adicione sua primeira conta de marketplace para começar.
            </div>
            <a
              href="/api/auth/mercadolivre"
              style={{
                display: "inline-flex", alignItems: "center", gap: "8px",
                background: "rgba(255,224,0,0.15)", border: "1px solid rgba(255,224,0,0.35)",
                padding: "10px 20px", borderRadius: "10px", color: "#FFE000",
                fontWeight: 700, fontSize: "14px", textDecoration: "none",
              }}
            >
              🛒 Conectar Mercado Livre
            </a>
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

      {/* ── Adicionar conta ── */}
      <section>
        <div style={{ marginBottom: "16px" }}>
          <h2 style={{ fontSize: "16px", fontWeight: 800, color: "#fff", margin: 0 }}>Adicionar conta</h2>
          <p style={{ fontSize: "12px", color: "#9099aa", marginTop: "4px" }}>
            Conecte quantas contas quiser. Cada uma aparece no seletor do topo.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))", gap: "14px" }}>

          {/* ML */}
          <a
            href="/api/auth/mercadolivre"
            style={{
              display: "block", textDecoration: "none",
              background: "rgba(255,224,0,0.05)", border: "1px solid rgba(255,224,0,0.18)",
              borderRadius: "14px", padding: "24px", cursor: "pointer",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,224,0,0.10)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,224,0,0.05)")}
          >
            <div style={{ fontSize: "30px", marginBottom: "12px" }}>🛒</div>
            <div style={{ fontWeight: 800, fontSize: "15px", color: "#FFE000", marginBottom: "6px" }}>
              Mercado Livre
            </div>
            <div style={{ fontSize: "12px", color: "#9099aa", lineHeight: 1.6, marginBottom: "18px" }}>
              Conecte via OAuth. Pode adicionar mais de uma conta ML ao mesmo tempo.
            </div>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              background: "rgba(255,224,0,0.15)", border: "1px solid rgba(255,224,0,0.3)",
              padding: "7px 14px", borderRadius: "8px", color: "#FFE000", fontWeight: 700, fontSize: "13px",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Adicionar conta ML
            </div>
          </a>

          {/* Shopee */}
          <a
            href="/api/auth/shopee"
            style={{
              display: "block", textDecoration: "none",
              background: "rgba(238,77,45,0.05)", border: "1px solid rgba(238,77,45,0.18)",
              borderRadius: "14px", padding: "24px", cursor: "pointer",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(238,77,45,0.10)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(238,77,45,0.05)")}
          >
            <div style={{ fontSize: "30px", marginBottom: "12px" }}>🛍️</div>
            <div style={{ fontWeight: 800, fontSize: "15px", color: "#EE4D2D", marginBottom: "6px" }}>
              Shopee
            </div>
            <div style={{ fontSize: "12px", color: "#9099aa", lineHeight: 1.6, marginBottom: "18px" }}>
              Conecte via Shopee Open Platform. Suporte a múltiplas lojas.
            </div>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              background: "rgba(238,77,45,0.15)", border: "1px solid rgba(238,77,45,0.3)",
              padding: "7px 14px", borderRadius: "8px", color: "#EE4D2D", fontWeight: 700, fontSize: "13px",
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Adicionar conta Shopee
            </div>
          </a>

        </div>
      </section>

    </div>
  );
}
