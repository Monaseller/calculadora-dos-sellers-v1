"use client";

/**
 * Estúdio de Anúncios — Listagem de Projetos Mestre.
 *
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): substitui o placeholder
 * da Fase 0. Usa EXCLUSIVAMENTE GET /api/estudio-anuncios/projetos
 * (rota já existente, sem paralelo/duplicata). Somente leitura — nenhum
 * botão de ação além de "Novo projeto" e "Abrir" (navegação de
 * detalhe). Não inicia Pipeline, não chama Worker/Gateway/RPC/Storage.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Adaptacao {
  id: string;
  marketplace: string;
  status: string;
}

interface ProjetoListado {
  id: string;
  nome_produto: string;
  modo: string;
  quantidade_imagens_solicitada: number;
  estilo?: string | null;
  status: string;
  criado_em: string;
  atualizado_em: string;
  adaptacoes: Adaptacao[];
}

const STATUS_CORES: Record<string, { cor: string; bg: string; border: string }> = {
  concluido: { cor: "#00D97E", bg: "rgba(0,217,126,0.12)", border: "rgba(0,217,126,0.35)" },
  erro_parcial: { cor: "#ff6b6b", bg: "rgba(255,80,80,0.12)", border: "rgba(255,80,80,0.35)" },
  cancelado: { cor: "#9099aa", bg: "rgba(144,153,170,0.12)", border: "rgba(144,153,170,0.3)" },
};

function corStatus(status: string) {
  return STATUS_CORES[status] ?? { cor: "#FFB600", bg: "rgba(255,182,0,0.12)", border: "rgba(255,182,0,0.35)" };
}

function formatarData(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function EstudioAnunciosListaPage() {
  const router = useRouter();
  const [projetos, setProjetos] = useState<ProjetoListado[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let ativo = true;
    async function carregar() {
      setCarregando(true);
      setErro(null);
      try {
        const res = await fetch("/api/estudio-anuncios/projetos");
        const data = await res.json();
        if (!ativo) return;
        if (!res.ok || !data.ok) {
          setErro(data.erro || "Não foi possível carregar os projetos.");
          setCarregando(false);
          return;
        }
        setProjetos(data.projetos ?? []);
        setCarregando(false);
      } catch {
        if (!ativo) return;
        setErro("Falha de conexão ao carregar os projetos.");
        setCarregando(false);
      }
    }
    carregar();
    return () => { ativo = false; };
  }, []);

  return (
    <div style={{ padding: "32px", maxWidth: "1100px", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "28px" }}>
        <div>
          <h1 style={{ fontSize: "24px", fontWeight: 900, color: "#fff", margin: 0 }}>Estúdio de Anúncios</h1>
          <p style={{ fontSize: "14px", color: "#9099aa", marginTop: "6px" }}>
            Projetos Mestre criados para geração de anúncios com IA.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push("/central-ia/estudio-anuncios/novo")}
          style={{
            padding: "10px 22px", borderRadius: "10px", border: "none",
            background: "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
            color: "#000", fontWeight: 800, fontSize: "14px", cursor: "pointer", whiteSpace: "nowrap",
          }}
        >
          + Novo projeto
        </button>
      </div>

      {erro && (
        <div style={{
          background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)",
          borderRadius: "10px", padding: "12px 16px", color: "#ff6b6b",
          fontSize: "13px", fontWeight: 600, marginBottom: "20px",
        }}>
          {erro}
        </div>
      )}

      {carregando && (
        <div style={{ color: "#9099aa", fontSize: "14px", padding: "40px 0", textAlign: "center" }}>
          Carregando projetos...
        </div>
      )}

      {!carregando && !erro && projetos.length === 0 && (
        <div style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "16px", padding: "48px 24px", textAlign: "center",
        }}>
          <p style={{ color: "#9099aa", fontSize: "14px", marginBottom: "16px" }}>
            Nenhum projeto ainda. Crie o primeiro Projeto Mestre para começar.
          </p>
          <button
            type="button"
            onClick={() => router.push("/central-ia/estudio-anuncios/novo")}
            style={{
              padding: "10px 24px", borderRadius: "10px", border: "none",
              background: "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
              color: "#000", fontWeight: 800, fontSize: "14px", cursor: "pointer",
            }}
          >
            + Novo projeto
          </button>
        </div>
      )}

      {!carregando && !erro && projetos.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {projetos.map(projeto => {
            const cores = corStatus(projeto.status);
            return (
              <div
                key={projeto.id}
                onClick={() => router.push(`/central-ia/estudio-anuncios/${projeto.id}`)}
                style={{
                  background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: "14px", padding: "18px 22px", cursor: "pointer",
                  display: "flex", justifyContent: "space-between", alignItems: "center", gap: "16px",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <span style={{ fontSize: "15px", fontWeight: 700, color: "#fff" }}>{projeto.nome_produto}</span>
                    <span style={{
                      fontSize: "11px", fontWeight: 700, padding: "2px 10px", borderRadius: "6px",
                      color: cores.cor, background: cores.bg, border: `1px solid ${cores.border}`,
                    }}>
                      {projeto.status}
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#9099aa", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                    <span>Modo: {projeto.modo}</span>
                    <span>{projeto.quantidade_imagens_solicitada} imagens</span>
                    <span>{(projeto.adaptacoes ?? []).map(a => a.marketplace).join(", ") || "sem marketplaces"}</span>
                    <span>Criado em {formatarData(projeto.criado_em)}</span>
                  </div>
                </div>
                <span style={{ color: "#9099aa", fontSize: "18px", flexShrink: 0 }}>›</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
