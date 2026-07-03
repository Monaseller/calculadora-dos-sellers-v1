"use client";

export default function SuportePage() {
  return (
    <div style={{ padding: "40px 32px" }}>
      <div style={{ maxWidth: 600 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 56, height: 56, borderRadius: 16,
          background: "rgba(255,107,0,0.12)", border: "1px solid rgba(255,107,0,0.2)",
          fontSize: 24, marginBottom: 24,
        }}>💬</div>
        <h1 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 12px 0" }}>
          Suporte
        </h1>
        <p style={{ fontSize: 15, color: "#9099aa", lineHeight: 1.7, margin: "0 0 32px 0" }}>
          Precisa de ajuda? Entre em contato pelo email abaixo e nossa equipe responderá em até 24h úteis.
        </p>
        <a
          href="mailto:suporte@calculadoradossellers.com.br"
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "12px 22px", borderRadius: 10,
            background: "linear-gradient(135deg,#ff6b00,#ffb800)",
            color: "#10131b", fontSize: 14, fontWeight: 800,
            textDecoration: "none",
          }}
        >
          ✉️ suporte@calculadoradossellers.com.br
        </a>
        <div style={{ marginTop: 40, padding: 20, borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#9099aa", marginBottom: 12, letterSpacing: "0.4px" }}>LINKS ÚTEIS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[
              { label: "Central de ajuda (em breve)", icon: "📖" },
              { label: "Tutorial de conexão com Mercado Livre (em breve)", icon: "🔗" },
              { label: "Tutorial de conexão com Shopee (em breve)", icon: "🔗" },
            ].map(({ label, icon }) => (
              <div key={label} style={{ fontSize: 14, color: "#d7dbe5", display: "flex", alignItems: "center", gap: 8 }}>
                <span>{icon}</span> {label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
