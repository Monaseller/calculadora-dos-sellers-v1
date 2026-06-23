"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const PAGE_INFO: Record<string, { title: string; desc: string }> = {
  "/dashboard":     { title: "Dashboard",              desc: "Visão geral dos seus anúncios e resultados." },
  "/precificacao":  { title: "Precificação",           desc: "Descubra o preço ideal para vender e lucrar em qualquer marketplace." },
  "/anuncios":      { title: "Meus Produtos",          desc: "Gerencie seus anúncios e acompanhe os resultados do dia." },
  "/vendas":        { title: "Vendas",                 desc: "Acompanhe suas vendas em tempo real." },
  "/configuracoes": { title: "Configurações",          desc: "Gerencie sua conta, plano e preferências." },
};

export default function TopBar() {
  const path = usePathname();
  const info = PAGE_INFO[path] ?? { title: "CDS", desc: "" };

  const [mlStatus, setMlStatus] = useState<"loading" | "connected" | "disconnected">("loading");
  const [mlNick, setMlNick]     = useState<string>("");

  useEffect(() => {
    fetch("/api/auth/status")
      .then(r => r.json())
      .then(d => {
        if (d.conectado) { setMlStatus("connected"); setMlNick(d.conta || ""); }
        else { setMlStatus("disconnected"); }
      })
      .catch(() => setMlStatus("disconnected"));
  }, []);

  return (
    <header style={{
      height: "64px",
      borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(10,11,16,0.95)",
      backdropFilter: "blur(12px)",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "0 28px",
      flexShrink: 0,
    }}>
      <div>
        <div style={{ fontWeight: 800, fontSize: "18px", color: "#fff", lineHeight: 1 }}>{info.title}</div>
        <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "2px" }}>{info.desc}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>

        {mlStatus === "loading" && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "999px", padding: "7px 16px", opacity: 0.5 }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#555" }} />
            <span style={{ fontSize: "13px", color: "#9099aa", fontWeight: 600 }}>Verificando...</span>
          </div>
        )}

        {mlStatus === "connected" && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "rgba(0,217,126,0.10)", border: "1px solid rgba(0,217,126,0.25)", borderRadius: "999px", padding: "7px 16px" }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#00D97E" }} />
            <span style={{ fontSize: "13px", color: "#00D97E", fontWeight: 700 }}>
              ML{mlNick ? ` · ${mlNick}` : " Conectado"}
            </span>
          </div>
        )}

        {mlStatus === "disconnected" && (
          <button
            onClick={() => { window.location.href = "/api/auth/ml"; }}
            style={{ display: "flex", alignItems: "center", gap: "8px", background: "linear-gradient(135deg,#FF6A00,#ffb800)", border: "none", borderRadius: "999px", padding: "8px 18px", cursor: "pointer", fontWeight: 800, fontSize: "13px", color: "#10131b" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            Conectar Mercado Livre
          </button>
        )}

        <button style={{ width: "38px", height: "38px", borderRadius: "10px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#9099aa", display: "grid", placeItems: "center", cursor: "pointer" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <div style={{ width: "36px", height: "36px", borderRadius: "50%", background: "linear-gradient(135deg,#ff6b00,#ffb800)", display: "grid", placeItems: "center", fontWeight: 900, fontSize: "13px", color: "#10131b" }}>R</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "13px", color: "#fff", lineHeight: 1 }}>Olá, Seller!</div>
            <div style={{ fontSize: "11px", color: "#9099aa", lineHeight: 1.3 }}>Ver perfil</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9099aa" strokeWidth="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
      </div>
    </header>
  );
}
