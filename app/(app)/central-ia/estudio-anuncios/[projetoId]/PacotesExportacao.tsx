"use client";

/**
 * Bloco de EXPORTAÇÃO do conteúdo aprovado (2026-08-21).
 *
 * Gerar um pacote congela dados estruturados no banco — **não publica em
 * marketplace, não envia arquivo para lugar nenhum, não gera download**.
 * O botão só fica disponível quando existe pelo menos uma versão
 * aprovada; sem aprovação, a UI diz isso em vez de oferecer a ação.
 *
 * Nenhuma query Supabase sai daqui: um único POST na rota dedicada, e a
 * recarga é do GET que a página já usa.
 */
import { useState } from "react";

export interface PacoteExportacaoDTO {
  id: string;
  numeroPacote: number | null;
  status: "gerado" | "parcial";
  hashConteudo: string | null;
  criadoEm: string;
  geradoPor: string | null;
  /** Materialização (2026-08-22). O caminho do Storage NUNCA chega aqui. */
  materializado: boolean;
  arquivo: {
    mimeType: string | null;
    tamanhoBytes: number | null;
    checksumSha256: string | null;
    materializadoEm: string | null;
  } | null;
  itens: {
    schemaVersao: number;
    nomeProduto: string;
    geradoEm: string;
    canais: (
      | { marketplace: string; exportavel: true; versaoAprovadaId: string; numeroVersao: number; aprovadoEm: string | null }
      | { marketplace: string; exportavel: false; motivo: string }
    )[];
    imagens: { imagemGeradaId: string; finalidade: string; principal: boolean }[];
    observacoes: string[];
  };
}

function Cartao({ titulo, acao, children }: { titulo: string; acao?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "24px", marginBottom: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "18px", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "15px", fontWeight: 800, color: "#fff", margin: 0 }}>{titulo}</h2>
        {acao}
      </div>
      {children}
    </div>
  );
}

function Selo({ texto, cor }: { texto: string; cor: string }) {
  return (
    <span style={{ fontSize: "10px", fontWeight: 800, color: cor, background: `${cor}1f`, border: `1px solid ${cor}55`, borderRadius: "6px", padding: "3px 8px", textTransform: "uppercase", letterSpacing: "0.4px", whiteSpace: "nowrap" }}>
      {texto}
    </span>
  );
}

function formatarData(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatarTamanho(bytes?: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Ações de arquivo de UM pacote (2026-08-22): gerar quando ainda não
 * existe, baixar quando existe. O download passa por uma URL assinada
 * pedida na hora — o componente nunca recebe nem guarda caminho de
 * Storage, e nenhuma URL é persistida.
 */
function AcoesArquivo({
  pacote, projetoId, onMudou,
}: {
  pacote: PacoteExportacaoDTO;
  projetoId: string;
  onMudou: () => void | Promise<void>;
}) {
  const [ocupado, setOcupado] = useState<null | "gerar" | "baixar">(null);
  const [erro, setErro] = useState<string | null>(null);
  const base = `/api/estudio-anuncios/projetos/${projetoId}/exportacao/${pacote.id}/arquivo`;

  async function gerar() {
    setOcupado("gerar");
    setErro(null);
    try {
      const res = await fetch(base, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) setErro(data.erro || "Não foi possível gerar o arquivo.");
      else await onMudou();
    } catch {
      setErro("Falha de conexão ao gerar o arquivo.");
    } finally {
      setOcupado(null);
    }
  }

  async function baixar() {
    setOcupado("baixar");
    setErro(null);
    try {
      const res = await fetch(base);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível preparar o download.");
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch {
      setErro("Falha de conexão ao preparar o download.");
    } finally {
      setOcupado(null);
    }
  }

  const estilo = (primario: boolean) => ({
    padding: "7px 14px", borderRadius: "8px", border: primario ? "none" : "1px solid rgba(255,255,255,0.18)",
    fontSize: "12px", fontWeight: 700,
    background: primario ? "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)" : "transparent",
    color: primario ? "#000" : "#cdd3dd",
    cursor: ocupado ? "not-allowed" : "pointer", opacity: ocupado ? 0.6 : 1,
  });

  return (
    <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
      {pacote.materializado ? (
        <>
          <button type="button" onClick={baixar} disabled={!!ocupado} style={estilo(true)}>
            {ocupado === "baixar" ? "Preparando..." : "Baixar"}
          </button>
          <span style={{ fontSize: "11px", color: "#9099aa" }}>
            ZIP · {formatarTamanho(pacote.arquivo?.tamanhoBytes)} · {formatarData(pacote.arquivo?.materializadoEm)}
          </span>
          {/* Se o objeto sumiu do Storage, isto reenvia o MESMO ZIP — não cria pacote novo. */}
          <button type="button" onClick={gerar} disabled={!!ocupado} style={estilo(false)}>
            {ocupado === "gerar" ? "Gerando..." : "Gerar novamente"}
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={gerar} disabled={!!ocupado} style={estilo(true)}>
            {ocupado === "gerar" ? "Gerando..." : "Gerar arquivo"}
          </button>
          <span style={{ fontSize: "11px", color: "#9099aa" }}>sem arquivo gerado</span>
        </>
      )}
      {erro && <span style={{ fontSize: "11px", color: "#ff6b6b", fontWeight: 600 }}>{erro}</span>}
    </div>
  );
}

export function BlocoExportacao({
  pacotes, podeExportar, projetoId, onMudou,
}: {
  pacotes: PacoteExportacaoDTO[];
  podeExportar: boolean;
  projetoId: string;
  onMudou: () => void | Promise<void>;
}) {
  const [gerando, setGerando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function gerar() {
    setGerando(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(`/api/estudio-anuncios/projetos/${projetoId}/exportacao`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível gerar o pacote.");
        return;
      }
      // Idempotência visível: o servidor devolve o pacote já existente
      // quando o conteúdo aprovado não mudou.
      if (data.reaproveitado) {
        setAviso(`Nada mudou desde o pacote ${data.pacote.numeroPacote} — nenhum pacote novo foi criado.`);
      }
      await onMudou();
    } catch {
      setErro("Falha de conexão ao gerar o pacote.");
    } finally {
      setGerando(false);
    }
  }

  const atual = pacotes[0] ?? null;

  return (
    <Cartao
      titulo="Exportação do conteúdo aprovado"
      acao={
        podeExportar ? (
          <button
            type="button"
            onClick={gerar}
            disabled={gerando}
            style={{
              padding: "9px 18px", borderRadius: "9px", border: "none", fontSize: "13px", fontWeight: 800,
              background: gerando ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
              color: "#000", cursor: gerando ? "not-allowed" : "pointer",
            }}
          >
            {gerando ? "Gerando..." : "Gerar pacote"}
          </button>
        ) : (
          <span style={{ fontSize: "11px", color: "#9099aa" }}>aprove uma versão para exportar</span>
        )
      }
    >
      {erro && (
        <div style={{ background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.3)", borderRadius: "10px", padding: "10px 14px", color: "#ff6b6b", fontSize: "13px", fontWeight: 600, marginBottom: "14px" }}>
          {erro}
        </div>
      )}
      {aviso && (
        <div style={{ background: "rgba(111,163,255,0.08)", border: "1px solid rgba(111,163,255,0.3)", borderRadius: "10px", padding: "10px 14px", color: "#6fa3ff", fontSize: "13px", fontWeight: 600, marginBottom: "14px" }}>
          {aviso}
        </div>
      )}

      {pacotes.length === 0 ? (
        <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>
          {podeExportar
            ? "Nenhum pacote gerado ainda. O pacote congela a versão aprovada de cada canal — não publica em nenhum marketplace."
            : "Nenhum canal tem versão aprovada. Aprove ao menos uma versão do conteúdo para poder exportar."}
        </p>
      ) : (
        <>
          {atual && (
            <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "12px", padding: "16px", marginBottom: "16px" }}>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center", marginBottom: "12px" }}>
                <Selo texto={`Pacote ${atual.numeroPacote}`} cor="#FFB600" />
                <Selo texto={atual.status === "gerado" ? "Completo" : "Parcial"} cor={atual.status === "gerado" ? "#00D97E" : "#FFD166"} />
                <span style={{ fontSize: "11px", color: "#9099aa" }}>{formatarData(atual.criadoEm)}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                {atual.itens.canais.map(c => (
                  <div key={c.marketplace} style={{ fontSize: "13px", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px" }}>
                    <div style={{ color: "#fff", fontWeight: 700, marginBottom: "3px" }}>{c.marketplace}</div>
                    {c.exportavel ? (
                      <div style={{ color: "#00D97E", fontSize: "12px" }}>versão {c.numeroVersao} aprovada</div>
                    ) : (
                      <div style={{ color: "#FFD166", fontSize: "12px" }}>{c.motivo}</div>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "12px" }}>
                {atual.itens.imagens.length} imagem(ns) referenciada(s) · identificador do conteúdo{" "}
                <code style={{ fontFamily: "monospace" }}>{atual.hashConteudo?.slice(0, 12)}</code>
              </div>
              <div style={{ marginTop: "14px", paddingTop: "14px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <AcoesArquivo pacote={atual} projetoId={projetoId} onMudou={onMudou} />
              </div>
            </div>
          )}

          {pacotes.length > 1 && (
            <details>
              <summary style={{ fontSize: "12px", color: "#9099aa", cursor: "pointer", fontWeight: 600 }}>
                Histórico de pacotes ({pacotes.length})
              </summary>
              <div style={{ overflowX: "auto", marginTop: "10px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "420px" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: "#9099aa", textTransform: "uppercase", fontSize: "10px" }}>
                      <th style={{ padding: "7px 8px" }}>Pacote</th>
                      <th style={{ padding: "7px 8px" }}>Gerado em</th>
                      <th style={{ padding: "7px 8px" }}>Status</th>
                      <th style={{ padding: "7px 8px" }}>Canais aprovados</th>
                      <th style={{ padding: "7px 8px" }}>Conteúdo</th>
                      <th style={{ padding: "7px 8px" }}>Arquivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pacotes.map(p => (
                      <tr key={p.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                        <td style={{ padding: "8px", color: "#fff", fontWeight: 700 }}>{p.numeroPacote}</td>
                        <td style={{ padding: "8px", color: "#9099aa" }}>{formatarData(p.criadoEm)}</td>
                        <td style={{ padding: "8px", color: p.status === "gerado" ? "#00D97E" : "#FFD166" }}>{p.status}</td>
                        <td style={{ padding: "8px", color: "#9099aa" }}>
                          {p.itens.canais.filter(c => c.exportavel).map(c => `${c.marketplace} v${(c as any).numeroVersao}`).join(", ") || "—"}
                        </td>
                        <td style={{ padding: "8px", color: "#9099aa", fontFamily: "monospace" }}>{p.hashConteudo?.slice(0, 10)}</td>
                        <td style={{ padding: "8px" }}>
                          <AcoesArquivo pacote={p} projetoId={projetoId} onMudou={onMudou} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          <p style={{ fontSize: "11px", color: "#9099aa", margin: "14px 0 0" }}>
            O pacote congela a versão aprovada de cada canal. Gerar de novo sem mudança reaproveita o pacote existente;
            trocar a versão aprovada cria um pacote novo e preserva o anterior. O arquivo ZIP é montado a partir do
            pacote congelado, não do estado atual do projeto. Nada é publicado em marketplace.
          </p>
        </>
      )}
    </Cartao>
  );
}
