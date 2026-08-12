"use client";

/**
 * Central de IA — Dashboard.
 *
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): substitui o placeholder
 * da Fase 0. Único módulo real hoje é o Estúdio de Anúncios — o card
 * abaixo linka só para /central-ia/estudio-anuncios (nenhuma rota
 * paralela em /central-ia/projetos). Busca a contagem de projetos via
 * GET /api/estudio-anuncios/projetos (rota já existente) só para dar
 * contexto — não inicia Pipeline, não chama Worker/Gateway/RPC/Storage.
 * Sidebar não foi alterado (fora do escopo desta tarefa).
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function CentralIAPage() {
  const router = useRouter();
  const [totalProjetos, setTotalProjetos] = useState<number | null>(null);

  useEffect(() => {
    let ativo = true;
    fetch("/api/estudio-anuncios/projetos")
      .then(res => res.json())
      .then(data => {
        if (!ativo) return;
        if (data.ok) setTotalProjetos((data.projetos ?? []).length);
      })
      .catch(() => {
        // Silencioso: o dashboard não depende dessa contagem para funcionar.
      });
    return () => { ativo = false; };
  }, []);

  return (
    <div style={{ padding: "32px", maxWidth: "1000px", margin: "0 auto" }}>
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 900, color: "#fff", margin: 0 }}>Central de IA</h1>
        <p style={{ fontSize: "14px", color: "#9099aa", marginTop: "6px" }}>
          Módulos de inteligência artificial do CDS.
        </p>
      </div>

      <div
        onClick={() => router.push("/central-ia/estudio-anuncios")}
        style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "16px", padding: "24px", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px",
          maxWidth: "480px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{
            width: "48px", height: "48px", borderRadius: "12px", flexShrink: 0,
            background: "rgba(255,107,0,0.12)", border: "1px solid rgba(255,107,0,0.2)",
            display: "grid", placeItems: "center", fontSize: "20px",
          }}>
            📢
          </div>
          <div>
            <div style={{ fontSize: "16px", fontWeight: 800, color: "#fff" }}>Estúdio de Anúncios</div>
            <div style={{ fontSize: "12px", color: "#9099aa", marginTop: "2px" }}>
              {totalProjetos === null ? "Geração de anúncios com IA" : `${totalProjetos} projeto${totalProjetos === 1 ? "" : "s"}`}
            </div>
          </div>
        </div>
        <span style={{ color: "#9099aa", fontSize: "18px", flexShrink: 0 }}>›</span>
      </div>
    </div>
  );
}
