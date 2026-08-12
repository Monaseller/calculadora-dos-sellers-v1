"use client";

/**
 * Estúdio de Anúncios — Novo Projeto (formulário funcional).
 *
 * AJUSTE (2026-08-06 — UI do Projeto Mestre): substitui o placeholder
 * da Fase 0. Usa EXCLUSIVAMENTE POST /api/estudio-anuncios/projetos
 * (rota já existente, nenhuma rota nova/paralela).
 *
 * AJUSTE (2026-08-08 — Upload real da foto do produto): a "foto
 * principal" (preview em memória, nunca enviada) virou um seletor
 * múltiplo de 1 a 10 fotos reais. Fluxo obrigatório (decisão de fluxo
 * da tarefa): o projeto é criado primeiro (POST .../projetos, 201) —
 * só DEPOIS desse 201 as fotos são enviadas para
 * POST /api/estudio-anuncios/projetos/[id]/fotos. Se a criação do
 * projeto suceder mas alguma foto falhar: o projeto NÃO é apagado
 * automaticamente, os arquivos que falharam são listados com o
 * motivo, e há um botão para tentar reenviar só os que falharam — sem
 * recriar o projeto. O Pipeline nunca é iniciado automaticamente
 * aqui (isso é outra tela/ação).
 */
import { useState, useRef } from "react";
import { useRouter } from "next/navigation";

type Marketplace = "ML" | "Shopee" | "Amazon" | "TikTok Shop";
type Modo = "rapido" | "profissional";
type Estilo = "minimalista" | "premium" | "tecnologico" | "luxo" | "clean" | "infantil" | "marketplace";

const MARKETPLACES: { valor: Marketplace; label: string }[] = [
  { valor: "ML", label: "Mercado Livre" },
  { valor: "Shopee", label: "Shopee" },
  { valor: "Amazon", label: "Amazon" },
  { valor: "TikTok Shop", label: "TikTok Shop" },
];

const QUANTIDADES = [4, 6, 8, 10];

const ESTILOS: { valor: Estilo; label: string }[] = [
  { valor: "minimalista", label: "Minimalista" },
  { valor: "premium", label: "Premium" },
  { valor: "tecnologico", label: "Tecnológico" },
  { valor: "luxo", label: "Luxo" },
  { valor: "clean", label: "Clean" },
  { valor: "infantil", label: "Infantil" },
  { valor: "marketplace", label: "Marketplace" },
];

const MAX_FOTOS = 10;
const TAMANHO_MAXIMO_BYTES = 10 * 1024 * 1024;
const MIME_ACEITOS = ["image/jpeg", "image/png", "image/webp"];

interface FotoSelecionada {
  arquivo: File;
  previewUrl: string;
}

interface FalhaUpload {
  nomeOriginal: string;
  motivo: string;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label style={{
      display: "block", fontSize: "12px", fontWeight: 700, color: "#9099aa",
      textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "8px",
    }}>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "10px", padding: "10px 14px", color: "#fff", fontSize: "14px",
  outline: "none", width: "100%", boxSizing: "border-box",
};

/** Faz o match (por nome, melhor esforço) entre os arquivos enviados e as falhas reportadas pela API. */
function filtrarArquivosComFalha(enviados: File[], falhas: FalhaUpload[]): File[] {
  const usados = new Set<number>();
  const resultado: File[] = [];
  for (const falha of falhas) {
    const idx = enviados.findIndex((f, i) => f.name === falha.nomeOriginal && !usados.has(i));
    if (idx !== -1) {
      usados.add(idx);
      resultado.push(enviados[idx]);
    }
  }
  return resultado;
}

export default function EstudioAnunciosNovoPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [nomeProduto, setNomeProduto] = useState("");
  const [fotos, setFotos] = useState<FotoSelecionada[]>([]);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [quantidadeImagens, setQuantidadeImagens] = useState<number>(8);
  const [modo, setModo] = useState<Modo>("rapido");
  const [permitirBuscaExterna, setPermitirBuscaExterna] = useState(false);
  const [estilo, setEstilo] = useState<Estilo>("minimalista");

  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Estado pós-criação do projeto (upload real das fotos).
  const [projetoCriadoId, setProjetoCriadoId] = useState<string | null>(null);
  const [enviandoFotos, setEnviandoFotos] = useState(false);
  const [fotosEnviadasComSucesso, setFotosEnviadasComSucesso] = useState(0);
  const [falhasUpload, setFalhasUpload] = useState<FalhaUpload[]>([]);
  const [arquivosPendentes, setArquivosPendentes] = useState<File[]>([]);
  const [erroFotos, setErroFotos] = useState<string | null>(null);

  function alternarMarketplace(m: Marketplace) {
    setMarketplaces(prev => (prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]));
  }

  function selecionarFotos(e: React.ChangeEvent<HTMLInputElement>) {
    const novosArquivos = Array.from(e.target.files || []);
    if (novosArquivos.length === 0) return;

    const espacoDisponivel = MAX_FOTOS - fotos.length;
    if (espacoDisponivel <= 0) {
      setErro(`Você já selecionou o máximo de ${MAX_FOTOS} fotos.`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const aceitos = novosArquivos.slice(0, espacoDisponivel);
    if (novosArquivos.length > espacoDisponivel) {
      setErro(`Só cabem mais ${espacoDisponivel} foto(s) (limite total: ${MAX_FOTOS}). Os arquivos extras foram ignorados.`);
    }

    const novasFotos: FotoSelecionada[] = [];
    for (const arquivo of aceitos) {
      if (!MIME_ACEITOS.includes(arquivo.type)) {
        setErro(`"${arquivo.name}" não é JPEG/PNG/WebP e foi ignorado.`);
        continue;
      }
      if (arquivo.size > TAMANHO_MAXIMO_BYTES) {
        setErro(`"${arquivo.name}" passa de 10MB e foi ignorado.`);
        continue;
      }
      novasFotos.push({ arquivo, previewUrl: URL.createObjectURL(arquivo) });
    }

    setFotos(prev => [...prev, ...novasFotos]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removerFoto(index: number) {
    setFotos(prev => {
      const alvo = prev[index];
      if (alvo) URL.revokeObjectURL(alvo.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  function validarLocal(): string | null {
    if (!nomeProduto.trim()) return "Informe o nome do produto.";
    if (marketplaces.length === 0) return "Selecione pelo menos um marketplace.";
    if (!QUANTIDADES.includes(quantidadeImagens)) return "Selecione uma quantidade de imagens válida.";
    if (modo !== "rapido" && modo !== "profissional") return "Selecione um modo válido.";
    if (!ESTILOS.some(x => x.valor === estilo)) return "Selecione um estilo válido.";
    if (fotos.length === 0) return "Selecione pelo menos 1 foto real do produto.";
    if (fotos.length > MAX_FOTOS) return `Selecione no máximo ${MAX_FOTOS} fotos.`;
    return null;
  }

  /** Envia (ou reenvia) um lote de arquivos já existentes para um projeto já criado. */
  async function enviarLoteFotos(idProjeto: string, arquivos: File[]) {
    setEnviandoFotos(true);
    setErroFotos(null);
    try {
      const formData = new FormData();
      arquivos.forEach(arquivo => formData.append("fotos", arquivo));

      const res = await fetch(`/api/estudio-anuncios/projetos/${idProjeto}/fotos`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        setErroFotos(data.erro || "Não foi possível enviar as fotos. Tente novamente.");
        setEnviandoFotos(false);
        return;
      }

      const falhas: FalhaUpload[] = data.falhas || [];
      const sucessosCount: number = (data.fotos || []).length;

      setFotosEnviadasComSucesso(prev => prev + sucessosCount);
      setFalhasUpload(falhas);
      setArquivosPendentes(filtrarArquivosComFalha(arquivos, falhas));
      setEnviandoFotos(false);

      if (falhas.length === 0) {
        router.push(`/central-ia/estudio-anuncios/${idProjeto}`);
      }
    } catch {
      setErroFotos("Falha de conexão ao enviar as fotos. Tente novamente.");
      setEnviandoFotos(false);
    }
  }

  async function criarProjeto() {
    const erroLocal = validarLocal();
    if (erroLocal) {
      setErro(erroLocal);
      return;
    }
    setErro(null);
    setEnviando(true);
    try {
      const res = await fetch("/api/estudio-anuncios/projetos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome_produto: nomeProduto.trim(),
          marketplaces,
          quantidade_imagens: quantidadeImagens,
          modo,
          permitir_busca_externa: permitirBuscaExterna,
          estilo,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setErro(data.erro || "Não foi possível criar o projeto. Tente novamente.");
        setEnviando(false);
        return;
      }

      // Projeto criado (201) — a partir daqui o projeto já existe de
      // fato. Não recriamos em caso de falha de foto: só reenviamos.
      setEnviando(false);
      setProjetoCriadoId(data.projeto.id);
      await enviarLoteFotos(data.projeto.id, fotos.map(f => f.arquivo));
    } catch {
      setErro("Falha de conexão ao criar o projeto. Tente novamente.");
      setEnviando(false);
    }
  }

  const totalFotos = fotos.length;
  const enviandoAlgo = enviando || enviandoFotos;
  const projetoJaCriado = !!projetoCriadoId;

  return (
    <div style={{ padding: "32px", maxWidth: "760px", margin: "0 auto" }}>
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{ fontSize: "24px", fontWeight: 900, color: "#fff", margin: 0 }}>Novo projeto</h1>
        <p style={{ fontSize: "14px", color: "#9099aa", marginTop: "6px" }}>
          Crie um Projeto Mestre no Estúdio de Anúncios com IA.
        </p>
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

      {projetoJaCriado && (
        <div style={{
          background: "rgba(0,217,127,0.06)", border: "1px solid rgba(0,217,127,0.25)",
          borderRadius: "10px", padding: "14px 16px", marginBottom: "20px",
        }}>
          <p style={{ fontSize: "13px", fontWeight: 700, color: "#00D97E", margin: 0 }}>
            Projeto criado. {fotosEnviadasComSucesso} de {totalFotos} foto(s) enviada(s) com sucesso.
          </p>
          {enviandoFotos && (
            <p style={{ fontSize: "12px", color: "#9099aa", marginTop: "8px" }}>Enviando fotos…</p>
          )}
          {!enviandoFotos && falhasUpload.length > 0 && (
            <div style={{ marginTop: "10px" }}>
              <p style={{ fontSize: "12px", color: "#ff6b6b", fontWeight: 700, margin: 0 }}>
                {falhasUpload.length} foto(s) não enviada(s):
              </p>
              <ul style={{ margin: "6px 0 0", paddingLeft: "18px" }}>
                {falhasUpload.map((f, i) => (
                  <li key={i} style={{ fontSize: "12px", color: "#9099aa" }}>
                    {f.nomeOriginal} — {f.motivo}
                  </li>
                ))}
              </ul>
              {erroFotos && (
                <p style={{ fontSize: "12px", color: "#ff6b6b", marginTop: "6px" }}>{erroFotos}</p>
              )}
              <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
                <button
                  type="button"
                  onClick={() => enviarLoteFotos(projetoCriadoId!, arquivosPendentes)}
                  disabled={enviandoAlgo}
                  style={{
                    padding: "8px 16px", borderRadius: "8px", border: "none",
                    background: "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
                    color: "#000", fontWeight: 800, fontSize: "13px", cursor: enviandoAlgo ? "not-allowed" : "pointer",
                  }}
                >
                  Tentar reenviar {arquivosPendentes.length} foto(s)
                </button>
                <button
                  type="button"
                  onClick={() => router.push(`/central-ia/estudio-anuncios/${projetoCriadoId}`)}
                  style={{
                    padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.1)",
                    background: "transparent", color: "#9099aa", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                  }}
                >
                  Ir para o projeto mesmo assim
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <fieldset
        disabled={projetoJaCriado}
        style={{ border: "none", padding: 0, margin: 0 }}
      >
        <div style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "16px", padding: "28px", display: "flex", flexDirection: "column", gap: "24px",
          opacity: projetoJaCriado ? 0.5 : 1,
        }}>
          {/* Nome do produto */}
          <div>
            <Label>Nome do produto *</Label>
            <input
              style={inputStyle}
              value={nomeProduto}
              onChange={e => setNomeProduto(e.target.value)}
              placeholder="Ex.: Fone de ouvido bluetooth XYZ"
            />
          </div>

          {/* Fotos reais do produto */}
          <div>
            <Label>Fotos do produto * ({totalFotos}/{MAX_FOTOS})</Label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginBottom: "12px" }}>
              {fotos.map((f, i) => (
                <div key={i} style={{ position: "relative", width: "80px", height: "80px" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={f.previewUrl}
                    alt={f.arquivo.name}
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "12px" }}
                  />
                  {i === 0 && (
                    <span style={{
                      position: "absolute", top: "-6px", left: "-6px", background: "#FFB600", color: "#000",
                      fontSize: "9px", fontWeight: 800, padding: "2px 6px", borderRadius: "6px",
                    }}>
                      Principal
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => removerFoto(i)}
                    style={{
                      position: "absolute", top: "-6px", right: "-6px", width: "20px", height: "20px",
                      borderRadius: "50%", border: "none", background: "#ff6b6b", color: "#fff",
                      fontSize: "12px", fontWeight: 800, cursor: "pointer", lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              {totalFotos < MAX_FOTOS && (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    width: "80px", height: "80px", borderRadius: "12px", flexShrink: 0, cursor: "pointer",
                    background: "rgba(255,255,255,0.04)", border: "1px dashed rgba(255,255,255,0.15)",
                    display: "grid", placeItems: "center",
                  }}
                >
                  <span style={{ fontSize: "24px", opacity: 0.4 }}>+</span>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={selecionarFotos}
              style={{ display: "none" }}
            />
            <p style={{ fontSize: "11px", color: "#9099aa", maxWidth: "420px" }}>
              De 1 a 10 fotos reais (JPEG, PNG ou WebP, até 10MB cada). A primeira vira a foto principal.
              O envio real acontece depois de criar o projeto.
            </p>
          </div>

          {/* Marketplaces */}
          <div>
            <Label>Marketplaces *</Label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              {MARKETPLACES.map(m => (
                <label
                  key={m.valor}
                  style={{
                    display: "flex", alignItems: "center", gap: "10px", cursor: "pointer",
                    background: marketplaces.includes(m.valor) ? "rgba(255,182,0,0.08)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${marketplaces.includes(m.valor) ? "rgba(255,182,0,0.4)" : "rgba(255,255,255,0.08)"}`,
                    borderRadius: "10px", padding: "10px 14px",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={marketplaces.includes(m.valor)}
                    onChange={() => alternarMarketplace(m.valor)}
                    style={{ accentColor: "#FFB600" }}
                  />
                  <span style={{ fontSize: "14px", color: "#fff" }}>{m.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Quantidade de imagens */}
          <div>
            <Label>Quantidade de imagens</Label>
            <select
              style={inputStyle}
              value={quantidadeImagens}
              onChange={e => setQuantidadeImagens(Number(e.target.value))}
            >
              {QUANTIDADES.map(q => (
                <option key={q} value={q}>{q} imagens</option>
              ))}
            </select>
          </div>

          {/* Modo */}
          <div>
            <Label>Modo</Label>
            <div style={{ display: "flex", gap: "12px" }}>
              {(["rapido", "profissional"] as Modo[]).map(m => (
                <label
                  key={m}
                  style={{
                    display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", flex: 1,
                    background: modo === m ? "rgba(255,182,0,0.08)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${modo === m ? "rgba(255,182,0,0.4)" : "rgba(255,255,255,0.08)"}`,
                    borderRadius: "10px", padding: "10px 14px",
                  }}
                >
                  <input type="radio" name="modo" checked={modo === m} onChange={() => setModo(m)} style={{ accentColor: "#FFB600" }} />
                  <span style={{ fontSize: "14px", color: "#fff", textTransform: "capitalize" }}>{m}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Permitir busca externa */}
          <div>
            <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={permitirBuscaExterna}
                onChange={e => setPermitirBuscaExterna(e.target.checked)}
                style={{ accentColor: "#FFB600" }}
              />
              <span style={{ fontSize: "14px", color: "#fff" }}>Permitir busca externa</span>
            </label>
          </div>

          {/* Estilo */}
          <div>
            <Label>Estilo</Label>
            <select style={inputStyle} value={estilo} onChange={e => setEstilo(e.target.value as Estilo)}>
              {ESTILOS.map(e => (
                <option key={e.valor} value={e.valor}>{e.label}</option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      {/* Botões */}
      {!projetoJaCriado && (
        <div style={{ display: "flex", gap: "12px", marginTop: "24px", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => router.push("/central-ia/estudio-anuncios")}
            disabled={enviandoAlgo}
            style={{
              padding: "10px 24px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.1)",
              background: "transparent", color: "#9099aa", fontWeight: 700, fontSize: "14px",
              cursor: enviandoAlgo ? "not-allowed" : "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={criarProjeto}
            disabled={enviandoAlgo}
            style={{
              padding: "10px 24px", borderRadius: "10px", border: "none",
              background: enviandoAlgo ? "rgba(255,182,0,0.3)" : "linear-gradient(135deg, #FFB600 0%, #FF6B00 100%)",
              color: "#000", fontWeight: 800, fontSize: "14px", cursor: enviandoAlgo ? "not-allowed" : "pointer",
            }}
          >
            {enviando ? "Criando..." : enviandoFotos ? "Enviando fotos..." : "Criar Projeto"}
          </button>
        </div>
      )}
    </div>
  );
}
