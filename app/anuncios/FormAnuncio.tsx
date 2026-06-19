"use client";
import { useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";
import { CATEGORIAS_ML, type TipoAnuncio } from "@/lib/comissoes-mercado-livre";
import { calcularPrecoIdealShopee, type TipoContaShopee } from "@/lib/comissoes-shopee";

interface Props {
  inicial: Anuncio | null;
  onSalvar: () => void;
  onFechar: () => void;
}

function parse(v: string) {
  return Number(String(v).replace(/\./g, "").replace(",", ".")) || 0;
}

type Etapa = "link" | "custos";

interface DadosML {
  id: string;
  titulo: string;
  preco: number | null;
  categoria: string | null;
  categoriaId: string | null;
  tipoAnuncio: string | null;
  thumbnail: string | null;
  permalink: string | null;
  parcial?: boolean;
}

export default function FormAnuncio({ inicial, onSalvar, onFechar }: Props) {
  const modoEdicao = !!inicial;
  const [etapa, setEtapa] = useState<Etapa>(modoEdicao ? "custos" : "link");

  // Link
  const [link,      setLink]      = useState("");
  const [buscando,  setBuscando]  = useState(false);
  const [erroLink,  setErroLink]  = useState("");
  const [dadosML,   setDadosML]   = useState<DadosML | null>(
    modoEdicao ? {
      id: inicial?.ml_item_id ?? "",
      titulo: inicial?.nome ?? "",
      preco: inicial?.preco_anuncio ?? null,
      categoria: inicial?.categoria ?? null,
      categoriaId: null,
      tipoAnuncio: inicial?.tipo_anuncio ?? null,
      thumbnail: inicial?.thumbnail ?? null,
      permalink: inicial?.permalink ?? null,
    } : null
  );

  // Custos
  const [marketplace,  setMarketplace]  = useState<"ML" | "Shopee">(inicial?.marketplace ?? "ML");
  const [tipoAnuncio,  setTipoAnuncio]  = useState<TipoAnuncio>((inicial?.tipo_anuncio as TipoAnuncio) ?? "Clássico");
  const [tipoConta,    setTipoConta]    = useState<TipoContaShopee>((inicial?.tipo_conta_shopee as TipoContaShopee) ?? "CNPJ");
  const [custoProduto, setCustoProduto] = useState(inicial?.custo_produto ? String(inicial.custo_produto).replace(".", ",") : "");
  const [insumos,      setInsumos]      = useState(inicial?.insumos ? String(inicial.insumos).replace(".", ",") : "0,00");
  const [custoFrete,   setCustoFrete]   = useState(inicial?.custo_frete ? String(inicial.custo_frete).replace(".", ",") : "6,75");
  const [freteGratis,  setFreteGratis]  = useState(inicial?.frete_gratis ?? false);
  const [imposto,      setImposto]      = useState(String(inicial?.imposto ?? 8));
  const [margem,       setMargem]       = useState(String(inicial?.margem_desejada ?? 20));
  const [salvando,     setSalvando]     = useState(false);
  const [erro,         setErro]         = useState("");

  // ── Buscar link ───────────────────────────────────────────────────────────
  async function buscarLink() {
    if (!link.trim()) { setErroLink("Cole o link do anúncio."); return; }
    setBuscando(true);
    setErroLink("");
    try {
      const res = await fetch(`/api/anuncio?link=${encodeURIComponent(link.trim())}`);
      const data = await res.json();
      if (data.erro) { setErroLink(data.mensagem); setBuscando(false); return; }
      const mp: "ML" | "Shopee" = link.includes("shopee") ? "Shopee" : "ML";
      setMarketplace(mp);
      if (data.tipoAnuncio === "Premium") setTipoAnuncio("Premium");
      else setTipoAnuncio("Clássico");
      setDadosML(data);
      setEtapa("custos");
    } catch {
      setErroLink("Erro ao buscar o anúncio. Tente novamente.");
    }
    setBuscando(false);
  }

  // ── Calcular preço ideal ──────────────────────────────────────────────────
  function calcPrecoIdeal(): number | null {
    const cp  = parse(custoProduto);
    const ins = parse(insumos);
    const cf  = freteGratis ? 0 : parse(custoFrete);
    const imp = Number(imposto) || 0;
    const mg  = Number(margem)  || 0;
    const categoriaFinal = dadosML?.categoria ?? "";
    const cat = CATEGORIAS_ML.find(c => c.nome.toLowerCase() === categoriaFinal.toLowerCase());

    if (marketplace === "ML") {
      if (!cat) return null;
      const comissao = tipoAnuncio === "Premium" ? cat.taxaPremium : cat.taxaClassico;
      const denom = 1 - comissao - imp / 100 - mg / 100;
      if (denom <= 0) return null;
      return (cp + ins + cf) / denom;
    } else {
      const res = calcularPrecoIdealShopee({ custoProduto: cp, insumos: ins, custoFrete: cf, impostoPercentual: imp, margemDesejadaPercentual: mg, tipoConta });
      return res.valido ? res.precoIdeal : null;
    }
  }

  // ── Salvar ────────────────────────────────────────────────────────────────
  async function salvar() {
    if (!custoProduto || parse(custoProduto) <= 0) { setErro("Informe o custo do produto."); return; }
    setSalvando(true);
    setErro("");
    const precoIdeal = calcPrecoIdeal();
    const payload = {
      nome: dadosML?.titulo ?? link,
      marketplace,
      categoria: dadosML?.categoria ?? null,
      tipo_anuncio: marketplace === "ML" ? tipoAnuncio : null,
      tipo_conta_shopee: marketplace === "Shopee" ? tipoConta : null,
      custo_produto: parse(custoProduto),
      insumos: parse(insumos),
      custo_frete: freteGratis ? 0 : parse(custoFrete),
      frete_gratis: freteGratis,
      imposto: Number(imposto) || 0,
      margem_desejada: Number(margem) || 0,
      preco_ideal: precoIdeal,
      preco_anuncio: dadosML?.preco ?? null,
      ml_item_id: dadosML?.id ?? null,
      thumbnail: dadosML?.thumbnail ?? null,
      permalink: dadosML?.permalink ?? null,
      ativo: true,
    };
    if (inicial) {
      await supabase.from("anuncios").update(payload).eq("id", inicial.id);
    } else {
      await supabase.from("anuncios").insert(payload);
    }
    setSalvando(false);
    onSalvar();
  }

  const precoIdeal = calcPrecoIdeal();
  const COR = marketplace === "ML" ? "#FFE600" : "#EE4D2D";
  const moeda = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "13px 16px", boxSizing: "border-box",
    borderRadius: "14px", border: "1.5px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)", color: "white",
    fontSize: "15px", outline: "none",
  };
  const labelStyle: React.CSSProperties = {
    display: "block", marginBottom: "7px",
    fontSize: "12px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.5px",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}
      onClick={e => e.target === e.currentTarget && onFechar()}
    >
      <div style={{ background: "#0d1220", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "28px", padding: "32px", width: "100%", maxWidth: "540px", maxHeight: "92vh", overflowY: "auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "20px" }}>
              {modoEdicao ? "Editar Anúncio" : etapa === "link" ? "Adicionar Anúncio" : "Configurar Custos"}
            </h2>
            <p style={{ margin: "4px 0 0", color: "#9099aa", fontSize: "13px" }}>
              {etapa === "link" ? "Cole o link do produto no Mercado Livre ou Shopee" : "Informe os custos do produto"}
            </p>
          </div>
          <button onClick={onFechar} style={{ background: "rgba(255,255,255,0.07)", border: "none", borderRadius: "10px", padding: "8px 14px", color: "#fff", cursor: "pointer", fontSize: "16px" }}>✕</button>
        </div>

        {/* ── ETAPA 1: Link ── */}
        {etapa === "link" && (
          <div>
            <div style={{ display: "flex", gap: "10px", marginBottom: "8px" }}>
              <input
                value={link}
                onChange={e => { setLink(e.target.value); setErroLink(""); }}
                onKeyDown={e => e.key === "Enter" && buscarLink()}
                placeholder="https://www.mercadolivre.com.br/..."
                style={{ ...inputStyle, flex: 1, border: erroLink ? "1.5px solid #ff4d4d" : "1.5px solid rgba(255,255,255,0.12)" }}
              />
              <button onClick={buscarLink} disabled={buscando} style={{
                padding: "13px 18px", whiteSpace: "nowrap",
                background: buscando ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
                border: "none", borderRadius: "14px", fontWeight: 800,
                color: buscando ? "#9099aa" : "#10131b", cursor: buscando ? "not-allowed" : "pointer", fontSize: "14px",
              }}>
                {buscando ? "⏳ Buscando..." : "🔍 Buscar"}
              </button>
            </div>
            {erroLink && <p style={{ color: "#ff4d4d", fontSize: "13px", margin: "4px 0 0" }}>{erroLink}</p>}
            <p style={{ color: "#9099aa", fontSize: "12px", margin: "16px 0 0", lineHeight: 1.6 }}>
              Cole o link de qualquer anúncio do Mercado Livre. O sistema vai buscar automaticamente o título, categoria e preço atual. Você só precisa informar o custo do produto.
            </p>
          </div>
        )}

        {/* ── ETAPA 2: Custos ── */}
        {etapa === "custos" && (
          <div>
            {/* Preview produto */}
            {dadosML && (
              <div style={{ display: "flex", gap: "14px", alignItems: "center", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "14px", marginBottom: "24px" }}>
                {dadosML.thumbnail && (
                  <img src={dadosML.thumbnail.replace("http://", "https://")} alt="" style={{ width: "52px", height: "52px", objectFit: "contain", borderRadius: "10px", background: "#fff", flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: "14px", lineHeight: 1.3, marginBottom: "5px" }}>{dadosML.titulo}</div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ background: marketplace === "ML" ? "rgba(255,230,0,0.15)" : "rgba(238,77,45,0.15)", color: COR, fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "2px 8px" }}>
                      {marketplace === "ML" ? "Mercado Livre" : "Shopee"}
                    </span>
                    {dadosML.categoria && <span style={{ color: "#9099aa", fontSize: "12px" }}>{dadosML.categoria}</span>}
                    {dadosML.preco && <span style={{ color: "#00D97E", fontSize: "13px", fontWeight: 700 }}>{moeda(dadosML.preco)}</span>}
                  </div>
                </div>
              </div>
            )}

            {/* Tipo anúncio ML */}
            {marketplace === "ML" && (
              <div style={{ marginBottom: "20px" }}>
                <span style={labelStyle}>TIPO DE ANÚNCIO</span>
                <div style={{ display: "flex", gap: "10px" }}>
                  {(["Clássico", "Premium"] as TipoAnuncio[]).map(t => (
                    <button key={t} onClick={() => setTipoAnuncio(t)} style={{
                      flex: 1, padding: "11px", borderRadius: "12px", border: "2px solid",
                      borderColor: tipoAnuncio === t ? "#FFE600" : "rgba(255,255,255,0.12)",
                      background: tipoAnuncio === t ? "rgba(255,230,0,0.1)" : "rgba(255,255,255,0.04)",
                      color: tipoAnuncio === t ? "#FFE600" : "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "14px",
                    }}>{t}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Tipo conta Shopee */}
            {marketplace === "Shopee" && (
              <div style={{ marginBottom: "20px" }}>
                <span style={labelStyle}>TIPO DE CONTA</span>
                <div style={{ display: "flex", gap: "10px" }}>
                  {(["CNPJ", "CPF"] as TipoContaShopee[]).map(t => (
                    <button key={t} onClick={() => setTipoConta(t)} style={{
                      flex: 1, padding: "11px", borderRadius: "12px", border: "2px solid",
                      borderColor: tipoConta === t ? "#EE4D2D" : "rgba(255,255,255,0.12)",
                      background: tipoConta === t ? "rgba(238,77,45,0.1)" : "rgba(255,255,255,0.04)",
                      color: tipoConta === t ? "#EE4D2D" : "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "14px",
                    }}>{t}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Custo produto */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>CUSTO DO PRODUTO (R$) *</span>
              <input value={custoProduto} onChange={e => setCustoProduto(e.target.value)} placeholder="Ex: 15,90" style={inputStyle} />
            </div>

            {/* Insumos + Imposto */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
              <div>
                <span style={labelStyle}>INSUMOS (R$)</span>
                <input value={insumos} onChange={e => setInsumos(e.target.value)} placeholder="0,00" style={inputStyle} />
              </div>
              <div>
                <span style={labelStyle}>IMPOSTO (%)</span>
                <input value={imposto} onChange={e => setImposto(e.target.value)} placeholder="8" style={inputStyle} />
              </div>
            </div>

            {/* Margem */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>MARGEM DESEJADA (%)</span>
              <input value={margem} onChange={e => setMargem(e.target.value)} placeholder="20" style={inputStyle} />
            </div>

            {/* Frete */}
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <div onClick={() => setFreteGratis(v => !v)} style={{ width: "42px", height: "24px", borderRadius: "12px", background: freteGratis ? "#00D97E" : "rgba(255,255,255,0.15)", cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
                <div style={{ position: "absolute", top: "3px", left: freteGratis ? "21px" : "3px", width: "18px", height: "18px", borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
              </div>
              <span style={{ fontWeight: 700, fontSize: "14px" }}>Frete Grátis</span>
            </div>
            {!freteGratis && (
              <div style={{ marginBottom: "16px" }}>
                <span style={labelStyle}>CUSTO DO FRETE (R$)</span>
                <input value={custoFrete} onChange={e => setCustoFrete(e.target.value)} placeholder="6,75" style={inputStyle} />
              </div>
            )}

            {/* Preço ideal preview */}
            {precoIdeal !== null ? (
              <div style={{ background: "rgba(0,217,126,0.08)", border: "1px solid rgba(0,217,126,0.25)", borderRadius: "16px", padding: "16px", marginBottom: "20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ color: "#9099aa", fontSize: "12px", fontWeight: 700, marginBottom: "2px" }}>PREÇO IDEAL</div>
                  <div style={{ fontSize: "26px", fontWeight: 900, color: "#00D97E" }}>{moeda(precoIdeal)}</div>
                </div>
                {dadosML?.preco && (
                  <div style={{ textAlign: "right" }}>
                    <div style={{ color: "#9099aa", fontSize: "12px", fontWeight: 700, marginBottom: "2px" }}>PREÇO ATUAL</div>
                    <div style={{ fontSize: "17px", fontWeight: 800, color: dadosML.preco >= precoIdeal ? "#00D97E" : "#ff4d4d" }}>{moeda(dadosML.preco)}</div>
                  </div>
                )}
              </div>
            ) : (
              marketplace === "ML" && dadosML?.categoria && (
                <div style={{ background: "rgba(255,180,0,0.08)", border: "1px solid rgba(255,180,0,0.2)", borderRadius: "14px", padding: "12px 16px", marginBottom: "20px", color: "#ffb800", fontSize: "13px" }}>
                  ⚠️ Categoria "{dadosML.categoria}" não mapeada. O preço ideal será calculado depois de editar.
                </div>
              )
            )}

            {erro && <p style={{ color: "#ff4d4d", marginBottom: "12px", fontSize: "14px" }}>{erro}</p>}

            <div style={{ display: "flex", gap: "10px" }}>
              {!modoEdicao && (
                <button onClick={() => setEtapa("link")} style={{ padding: "14px 18px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "14px", color: "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "14px" }}>← Voltar</button>
              )}
              <button onClick={salvar} disabled={salvando} style={{
                flex: 1, padding: "15px",
                background: salvando ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
                border: "none", borderRadius: "14px", fontWeight: 900, fontSize: "15px",
                color: salvando ? "#9099aa" : "#10131b", cursor: salvando ? "not-allowed" : "pointer",
              }}>
                {salvando ? "Salvando..." : modoEdicao ? "Salvar alterações" : "✅ Cadastrar Anúncio"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
