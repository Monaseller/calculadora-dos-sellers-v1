"use client";

export default function ComparativoPage() {
  return (
    <div style={{ padding: "40px 32px" }}>
      <div style={{ maxWidth: 600 }}>
        <div style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 56, height: 56, borderRadius: 16,
          background: "rgba(255,107,0,0.12)", border: "1px solid rgba(255,107,0,0.2)",
          fontSize: 24, marginBottom: 24,
        }}>📊</div>
        <h1 style={{ fontSize: 28, fontWeight: 900, margin: "0 0 12px 0" }}>
          Comparativo
        </h1>
        <p style={{ fontSize: 15, color: "#9099aa", lineHeight: 1.7, margin: "0 0 32px 0" }}>
          Em breve você poderá comparar o desempenho entre períodos, produtos e marketplaces —
          evolução de margem, faturamento, ROI e muito mais em um único painel.
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
