"use client";

/**
 * Publicação real no Mercado Livre (2026-08-31).
 *
 * É o único botão do Estúdio que cria um recurso público e que o usuário
 * não consegue desfazer sozinho. Por isso ele:
 *
 * - só aparece quando o SERVIDOR diz `podePublicarML` — a UI nunca
 *   decide isso;
 * - exige uma confirmação que mostra, em números, o que será criado
 *   (conta, preço, estoque, categoria, tipo de anúncio);
 * - some assim que o canal tem publicação viva.
 *
 * A UI desabilitada NÃO é a proteção contra duplo clique — a proteção
 * real é a reserva no banco, com índice UNIQUE. Isto aqui só evita o
 * incômodo.
 *
 * NÃO edita, NÃO pausa, NÃO fecha, NÃO exclui, NÃO sincroniza.
 */
import { useState } from "react";

export interface PublicacaoDTO {
  id: string;
  marketplace: string;
  status: "em_andamento" | "publicado" | "falha" | "publicacao_incerta";
  mlItemId: string | null;
  permalink: string | null;
  statusMl: string | null;
  criadoEm: string;
  concluidoEm: string | null;
  erro: unknown;
}

const VISUAL: Record<PublicacaoDTO["status"], { cor: string; icone: string; texto: string }> = {
  publicado: { cor: "#00D97E", icone: "🟢", texto: "Publicado no Mercado Livre" },
  em_andamento: { cor: "#FFD166", icone: "🟡", texto: "Publicação em andamento" },
  falha: { cor: "#ff6b6b", icone: "🔴", texto: "A publicação foi recusada" },
  publicacao_incerta: { cor: "#FFD166", icone: "⚠️", texto: "Publicação em estado incerto — precisa de conferência manual" },
};

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function reais(centavos: number | null) {
  if (centavos == null) return "—";
  return `R$ ${(centavos / 100).toFixed(2).replace(".", ",")}`;
}

const linha: React.CSSProperties = { fontSize: "12px", color: "#cdd3dd", display: "flex", gap: "8px", justifyContent: "space-between" };
const rotulo: React.CSSProperties = { color: "#9099aa" };

export function PublicarAnuncio({
  projetoId, publicacao, podePublicar, motivo, resumo, onMudou,
}: {
  projetoId: string;
  publicacao: PublicacaoDTO | null;
  /** Decidido no SERVIDOR. A UI só obedece. */
  podePublicar: boolean;
  motivo: string | null;
  resumo: {
    lojaNome: string | null;
    precoCentavos: number | null;
    estoque: number | null;
    categoriaNome: string | null;
    categoriaId: string | null;
    tipoAnuncioId: string | null;
    familyName: string | null;
  };
  onMudou: () => void | Promise<void>;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [publicando, setPublicando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function publicar() {
    setPublicando(true);
    setErro(null);
    try {
      const res = await fetch(
        `/api/estudio-anuncios/projetos/${projetoId}/marketplaces/mercado-livre/publicar`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível publicar.");
        return;
      }
      setConfirmando(false);
      await onMudou();
    } catch {
      // Falha de rede NA UI não diz nada sobre o servidor: ele pode ter
      // publicado. Por isso o texto não afirma que nada aconteceu.
      setErro("Não foi possível confirmar o resultado. Recarregue a página antes de tentar de novo.");
    } finally {
      setPublicando(false);
    }
  }

  const v = publicacao ? VISUAL[publicacao.status] : null;

  return (
    <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
      <h3 style={{ fontSize: "13px", fontWeight: 800, color: "#fff", margin: "0 0 4px" }}>Publicação</h3>

      {publicacao && v ? (
        <div style={{ marginTop: "10px", padding: "12px", borderRadius: "10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ fontSize: "12.5px", color: v.cor, fontWeight: 700, marginBottom: "10px" }}>
            {v.icone} {v.texto}
          </div>
          <div style={{ display: "grid", gap: "5px" }}>
            {publicacao.mlItemId && (
              <div style={linha}>
                <span style={rotulo}>Item</span>
                <code style={{ fontFamily: "monospace", color: "#fff" }}>{publicacao.mlItemId}</code>
              </div>
            )}
            {publicacao.statusMl && (
              <div style={linha}><span style={rotulo}>Status no ML</span><span>{publicacao.statusMl}</span></div>
            )}
            <div style={linha}><span style={rotulo}>Conta</span><span>{resumo.lojaNome ?? "—"}</span></div>
            <div style={linha}><span style={rotulo}>Preço</span><span>{reais(resumo.precoCentavos)}</span></div>
            <div style={linha}><span style={rotulo}>Estoque</span><span>{resumo.estoque ?? "—"}</span></div>
            <div style={linha}><span style={rotulo}>Publicado em</span><span>{formatarData(publicacao.concluidoEm ?? publicacao.criadoEm)}</span></div>
          </div>
          {publicacao.permalink && (
            <a
              href={publicacao.permalink}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: "inline-block", marginTop: "10px", fontSize: "12px", color: "#00D97E", fontWeight: 600 }}
            >
              Ver o anúncio no Mercado Livre ↗
            </a>
          )}
          {publicacao.status === "publicacao_incerta" && (
            <div style={{ fontSize: "11.5px", color: "#FFD166", marginTop: "10px", lineHeight: 1.5 }}>
              A resposta do Mercado Livre não permitiu concluir se o anúncio foi criado.
              <strong> Não tente publicar de novo</strong> — confira a conta antes, para não criar um segundo anúncio.
            </div>
          )}
          <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "10px" }}>
            Esta tela não edita, pausa nem encerra o anúncio.
          </div>
        </div>
      ) : confirmando ? (
        <div style={{ marginTop: "10px", padding: "12px", borderRadius: "10px", background: "rgba(255,209,102,0.06)", border: "1px solid rgba(255,209,102,0.3)" }}>
          <div style={{ fontSize: "12.5px", color: "#FFD166", fontWeight: 700, marginBottom: "8px" }}>
            Este anúncio será criado na conta do Mercado Livre selecionada.
          </div>
          <div style={{ display: "grid", gap: "5px", marginBottom: "12px" }}>
            <div style={linha}><span style={rotulo}>Conta</span><span>{resumo.lojaNome ?? "—"}</span></div>
            <div style={linha}><span style={rotulo}>Nome da família</span><span>{resumo.familyName ?? "—"}</span></div>
            <div style={linha}><span style={rotulo}>Preço</span><span>{reais(resumo.precoCentavos)}</span></div>
            <div style={linha}><span style={rotulo}>Estoque</span><span>{resumo.estoque ?? "—"}</span></div>
            <div style={linha}>
              <span style={rotulo}>Categoria</span>
              <span>{resumo.categoriaNome ?? "—"} <code style={{ fontFamily: "monospace", color: "#9099aa" }}>{resumo.categoriaId ?? ""}</code></span>
            </div>
            <div style={linha}><span style={rotulo}>Tipo de anúncio</span><span>{resumo.tipoAnuncioId ?? "—"}</span></div>
          </div>
          <div style={{ fontSize: "11.5px", color: "#9099aa", marginBottom: "12px", lineHeight: 1.5 }}>
            A criação é definitiva: o Estúdio não desfaz, não pausa e não exclui anúncios.
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={publicar}
              disabled={publicando}
              style={{
                padding: "9px 16px", borderRadius: "8px", border: "none", cursor: publicando ? "default" : "pointer",
                background: "#00D97E", color: "#0b0d12", fontSize: "12.5px", fontWeight: 800, opacity: publicando ? 0.6 : 1,
              }}
            >
              {publicando ? "Publicando…" : "Confirmar e publicar"}
            </button>
            <button
              onClick={() => setConfirmando(false)}
              disabled={publicando}
              style={{
                padding: "9px 16px", borderRadius: "8px", cursor: "pointer",
                background: "transparent", border: "1px solid rgba(255,255,255,0.18)", color: "#cdd3dd", fontSize: "12.5px", fontWeight: 600,
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: "8px" }}>
          <button
            onClick={() => setConfirmando(true)}
            disabled={!podePublicar}
            style={{
              padding: "9px 16px", borderRadius: "8px", border: "none", cursor: podePublicar ? "pointer" : "default",
              background: podePublicar ? "#00D97E" : "rgba(255,255,255,0.06)",
              color: podePublicar ? "#0b0d12" : "#6b7280", fontSize: "12.5px", fontWeight: 800,
            }}
          >
            Publicar no Mercado Livre
          </button>
          {!podePublicar && motivo && (
            <div style={{ fontSize: "11.5px", color: "#9099aa", marginTop: "8px" }}>{motivo}</div>
          )}
        </div>
      )}

      {erro && (
        <div style={{ fontSize: "12px", color: "#ff6b6b", marginTop: "10px" }}>{erro}</div>
      )}
    </div>
  );
}
