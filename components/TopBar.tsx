"use client";
import { usePathname } from "next/navigation";

const PAGE_INFO: Record<string, { title: string; desc: string }> = {
  "/dashboard":     { title: "Dashboard",              desc: "Visão geral dos seus anúncios e resultados." },
  "/precificacao":  { title: "Precificação",           desc: "Descubra o preço ideal para vender e lucrar em qualquer marketplace." },
  "/anuncios":      { title: "Meus Produtos",          desc: "Gerencie seus anúncios e acompanhe os resultados do dia." },
  "/historico":     { title: "Histórico de Cálculos",  desc: "Todos os cálculos salvos nos últimos 90 dias." },
  "/comparativo":   { title: "Comparativo",            desc: "Compare onde você lucra mais entre os marketplaces." },
  "/configuracoes": { title: "Configurações",          desc: "Gerencie sua conta, plano e preferências." },
  "/suporte":       { title: "Suporte",                desc: "Tire suas dúvidas ou fale com nossa equipe." },
};

export default function TopBar() {
  const path = usePathname();
  const info = PAGE_INFO[path] ?? { title: "CDS", desc: "" };

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
      {/* Título da página */}
      <div>
        <div style={{ fontWeight: 800, fontSize: "18px", color: "#fff", lineHeight: 1 }}>{info.title}</div>
        <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "2px" }}>{info.desc}</div>
      </div>

      {/* Direita */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* Badge plano */}
        <div style={{
          display: "flex", alignItems: "center", gap: "6px",
          background: "rgba(255,184,0,0.12)",
          border: "1px solid rgba(255,184,0,0.25)",
          borderRadius: "999px",
          padding: "6px 14px",
        }}>
          <span style={{ fontSize: "13px" }}>👑</span>
          <span style={{ fontWeight: 700, fontSize: "13px", color: "#ffb800" }}>Plano Vitalício</span>
        </div>

        {/* Sino */}
        <button style={{
          width: "38px", height: "38px",
          borderRadius: "10px",
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: "#9099aa",
          display: "grid", placeItems: "center",
          cursor: "pointer",
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </button>

        {/* Avatar + nome */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
          <div style={{
            width: "36px", height: "36px",
            borderRadius: "50%",
            background: "linear-gradient(135deg,#ff6b00,#ffb800)",
            display: "grid", placeItems: "center",
            fontWeight: 900, fontSize: "13px", color: "#10131b",
          }}>R</div>
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
