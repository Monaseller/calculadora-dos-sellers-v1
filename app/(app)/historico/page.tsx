"use client";

export default function HistoricoPage() {
  return (
    <div style={{ padding: "40px 32px" }}>
      <div style={{ maxWidth: 600 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 56, height: 56, borderRadius: 16,
          background: "rgba(255,107,0,0.12)", border: "1px solid rgba(255,107,0,0.2)",
          fontSize: 24, marginBottom: 24,
        }}>🕐</div>
        <h1 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 12px 0" }}>
          Histórico de Cálculos
        </h1>
        <p style={{ fontSize: 15, color: "#9099aa", lineHeight: 1.7, margin: "0 0 32px 0" }}>
          Em breve você poderá acessar o histórico completo de todas as precificações realizadas,
          filtrar por produto, período e comparar margens ao longo do tempo.
        </p>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "10px 18px", borderRadius: 10,
          background: "rgba(255,107,0,0.08)", border: "1px solid rgba(255,107,0,0.15)",
          color: "#ff6b00", fontSize: 13, fontWeight: 700,
        }}>
          🚀 Em desenvolvimento
        </div>
      </div>
    </div>
  );
}
