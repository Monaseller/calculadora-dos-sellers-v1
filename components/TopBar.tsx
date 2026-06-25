"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const PAGE_INFO: Record<string, { title: string; desc: string }> = {
  "/dashboard":     { title: "Dashboard",     desc: "Visão geral dos seus anúncios e resultados." },
  "/precificacao":  { title: "Precificação",  desc: "Descubra o preço ideal para vender e lucrar em qualquer marketplace." },
  "/anuncios":      { title: "Meus Produtos", desc: "Gerencie seus anúncios e acompanhe os resultados do dia." },
  "/vendas":        { title: "Vendas",        desc: "Acompanhe suas vendas em tempo real." },
  "/configuracoes": { title: "Configurações", desc: "Gerencie suas lojas e conexões." },
};

type Loja = { id: string; nome: string; marketplace: string; nickname: string | null };

function getCookieClient(name: string): string | null {
  if (typeof document === "undefined") return null;
  const entry = document.cookie.split("; ").find(c => c.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

export default function TopBar() {
  const path   = usePathname();
  const router = useRouter();
  const info   = PAGE_INFO[path] ?? { title: "CDS", desc: "" };

  const [lojas,     setLojas]     = useState<Loja[]>([]);
  const [lojaAtiva, setLojaAtiva] = useState<string | null>(null);
  const [dropdown,  setDropdown]  = useState(false);
  const [trocando,  setTrocando]  = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    carregarLojas();
    function handleClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropdown(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function carregarLojas() {
    try {
      const res = await fetch("/api/lojas");
      const data = await res.json();
      if (Array.isArray(data)) setLojas(data);
    } catch {}
    setLojaAtiva(getCookieClient("loja_ativa_id"));
  }

  async function trocarLoja(id: string) {
    if (trocando || id === lojaAtiva) { setDropdown(false); return; }
    setTrocando(true);
    try {
      await fetch("/api/lojas/ativar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loja_id: id }),
      });
      setLojaAtiva(id);
      setDropdown(false);
      router.refresh();
    } finally { setTrocando(false); }
  }

  const ativa = lojas.find(l => l.id === lojaAtiva);

  return (
    <header style={{
      height: "64px", borderBottom: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(10,11,16,0.95)", backdropFilter: "blur(12px)",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 28px", flexShrink: 0, position: "relative", zIndex: 100,
    }}>

      {/* Título */}
      <div>
        <div style={{ fontWeight: 800, fontSize: "18px", color: "#fff", lineHeight: 1 }}>{info.title}</div>
        <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "2px" }}>{info.desc}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>

        {/* ── Seletor de loja ── */}
        <div ref={dropRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdown(d => !d)}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              background: ativa ? "rgba(255,224,0,0.08)" : "rgba(255,80,80,0.08)",
              border: ativa ? "1px solid rgba(255,224,0,0.25)" : "1px solid rgba(255,80,80,0.25)",
              borderRadius: "999px", padding: "7px 14px", cursor: "pointer",
            }}
          >
            <div style={{
              width: "8px", height: "8px", borderRadius: "50%",
              background: ativa ? "#00D97E" : "#ff6b6b",
            }} />
            <span style={{ fontSize: "13px", fontWeight: 700, color: ativa ? "#FFE000" : "#ff6b6b" }}>
              {ativa ? (ativa.nickname || ativa.nome) : "Conectar loja"}
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9099aa" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>

          {dropdown && (
            <div style={{
              position: "absolute", top: "calc(100% + 8px)", right: 0, minWidth: "240px",
              background: "#14161f", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "12px", padding: "8px", boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 9999,
            }}>
              {lojas.length === 0 ? (
                <div style={{ padding: "12px 14px", color: "#9099aa", fontSize: "13px" }}>
                  Nenhuma loja conectada ainda
                </div>
              ) : (
                lojas.map(l => {
                  const isAtiva = l.id === lojaAtiva;
                  return (
                    <button key={l.id} onClick={() => trocarLoja(l.id)} style={{
                      width: "100%", display: "flex", alignItems: "center", gap: "10px",
                      padding: "10px 12px", borderRadius: "8px", border: "none",
                      background: isAtiva ? "rgba(100,160,255,0.1)" : "transparent",
                      cursor: "pointer", textAlign: "left",
                    }}
                    onMouseEnter={e => { if (!isAtiva) e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                    onMouseLeave={e => { if (!isAtiva) e.currentTarget.style.background = "transparent"; }}
                    >
                      <span style={{ fontSize: "16px" }}>{l.marketplace === "ML" ? "🛒" : "🛍️"}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "13px", fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {l.nickname || l.nome}
                        </div>
                        <div style={{ fontSize: "11px", color: "#9099aa" }}>{l.marketplace}</div>
                      </div>
                      {isAtiva && (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00D97E" strokeWidth="2.5">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                      )}
                    </button>
                  );
                })
              )}

              <div style={{ height: "1px", background: "rgba(255,255,255,0.07)", margin: "6px 0" }} />
              <button onClick={() => { setDropdown(false); router.push("/configuracoes"); }}
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: "10px",
                  padding: "10px 12px", borderRadius: "8px", border: "none",
                  background: "transparent", cursor: "pointer", color: "#9099aa", fontSize: "13px", fontWeight: 600,
                }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
                Gerenciar lojas
              </button>
            </div>
          )}
        </div>

        {/* ── Engrenagem ── */}
        <button onClick={() => router.push("/configuracoes")} title="Configurações" style={{
          width: "38px", height: "38px", borderRadius: "10px",
          background: path === "/configuracoes" ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          color: path === "/configuracoes" ? "#fff" : "#9099aa",
          display: "grid", placeItems: "center", cursor: "pointer",
        }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>

        {/* Avatar */}
        <div style={{ width: "34px", height: "34px", borderRadius: "50%", background: "linear-gradient(135deg,#ff6b00,#ffb800)", display: "grid", placeItems: "center", fontWeight: 900, fontSize: "13px", color: "#10131b", cursor: "pointer" }}
             onClick={() => router.push("/configuracoes")}>
          R
        </div>

      </div>
    </header>
  );
}
