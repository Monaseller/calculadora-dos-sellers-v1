"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIAS_ML, type TipoAnuncio } from "@/lib/comissoes-mercado-livre";
import { calcularPrecoIdealShopee, type TipoContaShopee, FAIXAS_SHOPEE, TAXA_CAMPANHA_SHOPEE } from "@/lib/comissoes-shopee";
import { moeda } from "@/lib/cds-engine";

type Marketplace = "ML" | "Shopee";

function parseN(v: string) {
  return Number(v.replace(/\./g, "").replace(",", ".")) || 0;
}

const PRESETS_PCT = [5, 10, 15, 20, 25, 30];

const SELECT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "13px 14px",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.15)",
  background: "#0d1017",
  color: "#fff",
  fontSize: "14px",
  outline: "none",
  appearance: "none",
  cursor: "pointer",
};

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "13px 14px",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.15)",
  background: "#0d1017",
  color: "#fff",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 700,
  color: "#9099aa",
  marginBottom: "6px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

export default function PrecificacaoPage() {
  const [marketplace,     setMarketplace]     = useState<Marketplace>("ML");
  const [categoriaNome,   setCategoriaNome]   = useState(CATEGORIAS_ML[0].nome);
  const [tipoAnuncio,     setTipoAnuncio]     = useState<TipoAnuncio>("Clássico");
  const [tipoContaShopee, setTipoContaShopee] = useState<TipoContaShopee>("CNPJ");
  const [freteGratis,     setFreteGratis]     = useState(false);
  const [custoFrete,      setCustoFrete]      = useState("6,75");
  const [custoProduto,    setCustoProduto]    = useState("50,00");
  const [insumos,         setInsumos]         = useState("0,00");
  const [imposto,         setImposto]         = useState("10");
  const [margemDesejada,  setMargemDesejada]  = useState("20");
  const [promocao,        setPromocao]        = useState(20);
  const [customPct,       setCustomPct]       = useState("");
  const [showCustom,      setShowCustom]      = useState(false);
  const [mlConectado,     setMlConectado]     = useState<boolean | null>(null);

  // ── Simulador "e se?" ──────────────────────────────────────────────────────
  const [simMode,         setSimMode]         = useState<"preco" | "margem">("preco");
  const [simPreco,        setSimPreco]        = useState("");
  const [simMargem,       setSimMargem]       = useState("");

  useEffect(() => {
    fetch("/api/auth/status")
      .then(r => r.json())
      .then(d => setMlConectado(d.conectado))
      .catch(() => setMlConectado(false));
  }, []);

  // ── Cálculo ML ─────────────────────────────────────────────────────────────
  const resultadoML = useMemo(() => {
    if (marketplace !== "ML") return null;
    const cat = CATEGORIAS_ML.find(c => c.nome === categoriaNome);
    if (!cat) return null;

    const com = tipoAnuncio === "Premium" ? cat.premium : cat.classico;
    const cp  = parseN(custoProduto);
    const ins = parseN(insumos);
    const cf  = freteGratis ? 0 : parseN(custoFrete);
    const imp = parseN(imposto) / 100;
    const mg  = parseN(margemDesejada) / 100;

    const denom = 1 - com - imp - mg;
    if (denom <= 0) return { invalido: true as const, com };

    const precoIdeal    = (cp + ins + cf) / denom;
    const comissaoValor = precoIdeal * com;
    const impostoValor  = precoIdeal * imp;
    const lucroValor    = precoIdeal * mg;

    return { invalido: false as const, precoIdeal, comissaoValor, impostoValor, lucroValor, cp, ins, cf, com };
  }, [marketplace, categoriaNome, tipoAnuncio, custoProduto, insumos, custoFrete, freteGratis, imposto, margemDesejada]);

  // ── Cálculo Shopee ──────────────────────────────────────────────────────────
  const resultadoShopee = useMemo(() => {
    if (marketplace !== "Shopee") return null;
    return calcularPrecoIdealShopee({
      custoProduto: parseN(custoProduto),
      insumos:      parseN(insumos),
      custoFrete:   freteGratis ? 0 : parseN(custoFrete),
      impostoPercentual:        parseN(imposto),
      margemDesejadaPercentual: parseN(margemDesejada),
      tipoConta: tipoContaShopee,
    });
  }, [marketplace, custoProduto, insumos, custoFrete, freteGratis, imposto, margemDesejada, tipoContaShopee]);

  // ── Preço ideal e promoção ──────────────────────────────────────────────────
  const precoIdeal =
    marketplace === "ML"
      ? (resultadoML?.invalido === false ? resultadoML.precoIdeal : null)
      : (resultadoShopee?.valido ? resultadoShopee.precoIdeal : null);

  const precoComPromocao = precoIdeal && promocao > 0
    ? precoIdeal / (1 - promocao / 100)
    : null;

  const mg = parseN(margemDesejada) / 100;
  const lucroUnitario = precoIdeal ? precoIdeal * mg : null;

  const sliderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (sliderRef.current) {
      sliderRef.current.style.setProperty("--pct", `${(promocao / 50) * 100}%`);
    }
  }, [promocao]);

  // ── Breakdown rows ──────────────────────────────────────────────────────────
  const breakdownRows = useMemo(() => {
    if (!precoIdeal) return [];
    const pi = precoIdeal;

    if (marketplace === "ML" && resultadoML && !resultadoML.invalido) {
      const { comissaoValor, impostoValor, lucroValor, cp, ins, cf } = resultadoML;
      return [
        { label: "Lucro líquido",           val: moeda(lucroValor),    pct: `${parseN(margemDesejada).toFixed(2)}%`, positivo: true },
        { label: "Margem líquida",           val: `${parseN(margemDesejada).toFixed(2)}%`, pct: `${parseN(margemDesejada).toFixed(2)}%`, positivo: true },
        { label: "Comissão do marketplace",  val: moeda(comissaoValor), pct: `-${(comissaoValor/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Impostos",                 val: moeda(impostoValor),  pct: `-${parseN(imposto).toFixed(2)}%`, positivo: false },
        { label: "Custo de envio",           val: freteGratis ? "Grátis" : moeda(cf),  pct: freteGratis ? "—" : `-${(cf/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Custo do produto",         val: moeda(cp),            pct: `-${(cp/pi*100).toFixed(2)}%`, positivo: false },
        ...(ins > 0 ? [{ label: "Insumos", val: moeda(ins), pct: `-${(ins/pi*100).toFixed(2)}%`, positivo: false }] : []),
        { label: "Receita Total",            val: moeda(pi),            pct: "100%", positivo: true, destaque: true },
      ];
    }

    if (marketplace === "Shopee" && resultadoShopee?.valido) {
      const r = resultadoShopee;
      return [
        { label: "Lucro líquido",           val: moeda(r.lucroValor),       pct: `${parseN(margemDesejada).toFixed(2)}%`, positivo: true },
        { label: "Margem líquida",           val: `${parseN(margemDesejada).toFixed(2)}%`, pct: `${parseN(margemDesejada).toFixed(2)}%`, positivo: true },
        { label: "Comissão do marketplace",  val: moeda(r.comissaoValor),    pct: `-${(r.comissaoValor/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Taxa campanha (2,5%)",     val: moeda(r.taxaCampanhaValor),pct: `-2.50%`, positivo: false },
        { label: "Taxa fixa",               val: moeda(r.taxaFixaValor),    pct: `-${(r.taxaFixaValor/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Impostos",                val: moeda(r.impostoValor),     pct: `-${parseN(imposto).toFixed(2)}%`, positivo: false },
        { label: "Custo de envio",          val: freteGratis ? "Grátis" : moeda(r.cf), pct: freteGratis ? "—" : `-${(r.cf/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Custo do produto",        val: moeda(r.cp),               pct: `-${(r.cp/pi*100).toFixed(2)}%`, positivo: false },
        { label: "Receita Total",           val: moeda(pi),                 pct: "100%", positivo: true, destaque: true },
      ];
    }
    return [];
  }, [precoIdeal, marketplace, resultadoML, resultadoShopee, margemDesejada, imposto, freteGratis]);

  // ── Cálculo simulador ──────────────────────────────────────────────────────
  const simResultado = useMemo(() => {
    const cp  = parseN(custoProduto);
    const ins = parseN(insumos);
    const cf  = freteGratis ? 0 : parseN(custoFrete);
    const imp = parseN(imposto) / 100;

    // taxa de comissão atual
    let comRate = 0;
    if (marketplace === "ML") {
      const cat = CATEGORIAS_ML.find(c => c.nome === categoriaNome);
      if (cat) comRate = tipoAnuncio === "Premium" ? cat.premium : cat.classico;
    } else {
      // Shopee: usa preço ideal atual para estimar a faixa de comissão
      const precoRef = precoIdeal || 100;
      const faixa = FAIXAS_SHOPEE.find(f => precoRef >= f.min && precoRef < f.max) ?? FAIXAS_SHOPEE[0];
      comRate = faixa.comissao + TAXA_CAMPANHA_SHOPEE;
    }

    if (simMode === "preco") {
      const p = parseN(simPreco);
      if (!p) return null;
      const comissao = p * comRate;
      const impostoV = p * imp;
      const custos   = cp + ins + cf + comissao + impostoV;
      const lucro    = p - custos;
      const mcPct    = (lucro / p) * 100;
      const diffPreco = precoIdeal ? p - precoIdeal : null;
      const diffMC    = precoIdeal ? mcPct - parseN(margemDesejada) : null;
      return { p, comissao, impostoV, lucro, mcPct, diffPreco, diffMC, custos };
    } else {
      // modo margem: qual preço cobrar para ter simMargem%
      const mg  = parseN(simMargem) / 100;
      const den = 1 - comRate - imp - mg;
      if (den <= 0) return null;
      const p        = (cp + ins + cf) / den;
      const comissao = p * comRate;
      const impostoV = p * imp;
      const lucro    = p * mg;
      const diffPreco = precoIdeal ? p - precoIdeal : null;
      const diffMC    = precoIdeal ? mg * 100 - parseN(margemDesejada) : null;
      return { p, comissao, impostoV, lucro, mcPct: mg * 100, diffPreco, diffMC };
    }
  }, [simMode, simPreco, simMargem, custoProduto, insumos, custoFrete, freteGratis, imposto,
      marketplace, categoriaNome, tipoAnuncio, tipoContaShopee, precoIdeal, margemDesejada]);

  return (
    <div style={{ padding: "28px 36px", width: "100%", boxSizing: "border-box" }}>

      {/* ── Seção 1 + 2: Configure | Resultado ─────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "20px" }}>

        {/* ── Card 1: Configurar ─────────────────────────────────────────── */}
        <div style={{
          background: "#161921",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "20px",
          padding: "24px",
        }}>
          <div style={{ fontSize: "14px", fontWeight: 800, color: "#9099aa", marginBottom: "20px" }}>
            <span style={{
              background: "#FF6A00", color: "#fff",
              borderRadius: "50%", width: "22px", height: "22px",
              display: "inline-grid", placeItems: "center",
              fontSize: "12px", fontWeight: 900, marginRight: "8px",
            }}>1</span>
            Configure os dados do seu produto
          </div>

          {/* Marketplace + sub-tipo */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
            <div>
              <label style={LABEL_STYLE}>Marketplace</label>
              <div style={{ position: "relative" }}>
                <select value={marketplace} onChange={e => setMarketplace(e.target.value as Marketplace)} style={SELECT_STYLE}>
                  <option value="ML">Mercado Livre</option>
                  <option value="Shopee">Shopee</option>
                </select>
                <svg style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9099aa" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
            <div>
              <label style={LABEL_STYLE}>{marketplace === "ML" ? "Tipo de anúncio" : "Tipo de conta"}</label>
              <div style={{ position: "relative" }}>
                {marketplace === "ML" ? (
                  <select value={tipoAnuncio} onChange={e => setTipoAnuncio(e.target.value as TipoAnuncio)} style={SELECT_STYLE}>
                    <option value="Clássico">Clássico</option>
                    <option value="Premium">Premium</option>
                  </select>
                ) : (
                  <select value={tipoContaShopee} onChange={e => setTipoContaShopee(e.target.value as TipoContaShopee)} style={SELECT_STYLE}>
                    <option value="CNPJ">CNPJ</option>
                    <option value="CPF">CPF</option>
                  </select>
                )}
                <svg style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9099aa" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
          </div>

          {/* Categoria (apenas ML) */}
          {marketplace === "ML" && (
            <div style={{ marginBottom: "16px" }}>
              <label style={LABEL_STYLE}>Categoria</label>
              <div style={{ position: "relative" }}>
                <select value={categoriaNome} onChange={e => setCategoriaNome(e.target.value)} style={SELECT_STYLE}>
                  {CATEGORIAS_ML.map(c => <option key={c.nome} value={c.nome}>{c.nome}</option>)}
                </select>
                <svg style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9099aa" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
              </div>
            </div>
          )}

          {/* Custo produto + Imposto + Margem */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
            <div>
              <label style={LABEL_STYLE}>Custo produto (R$)</label>
              <input value={custoProduto} onChange={e => setCustoProduto(e.target.value)} placeholder="0,00" style={INPUT_STYLE} />
            </div>
            <div>
              <label style={LABEL_STYLE}>Imposto (%)</label>
              <input value={imposto} onChange={e => setImposto(e.target.value)} placeholder="10" style={INPUT_STYLE} />
            </div>
            <div>
              <label style={LABEL_STYLE}>Margem desejada (%)</label>
              <input value={margemDesejada} onChange={e => setMargemDesejada(e.target.value)} placeholder="20" style={INPUT_STYLE} />
            </div>
          </div>

          {/* Insumos + Frete */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
            <div>
              <label style={LABEL_STYLE}>Insumos (R$)</label>
              <input value={insumos} onChange={e => setInsumos(e.target.value)} placeholder="0,00" style={INPUT_STYLE} />
            </div>
            <div>
              <label style={LABEL_STYLE}>Frete grátis?</label>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", height: "46px" }}>
                <div onClick={() => setFreteGratis(v => !v)} style={{
                  width: "44px", height: "24px", borderRadius: "12px",
                  background: freteGratis ? "#00D97E" : "rgba(255,255,255,0.12)",
                  cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0,
                }}>
                  <div style={{
                    position: "absolute", top: "3px",
                    left: freteGratis ? "23px" : "3px",
                    width: "18px", height: "18px",
                    borderRadius: "50%", background: "#fff",
                    transition: "left 0.2s",
                  }}/>
                </div>
                {!freteGratis && (
                  <input value={custoFrete} onChange={e => setCustoFrete(e.target.value)} placeholder="6,75"
                    style={{ ...INPUT_STYLE, flex: 1 }} />
                )}
                {freteGratis && <span style={{ color: "#00D97E", fontWeight: 700, fontSize: "13px" }}>Grátis</span>}
              </div>
            </div>
          </div>

          {/* Slider promoção */}
          <div style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <label style={{ ...LABEL_STYLE, margin: 0 }}>Percentual de promoção desejado (%)</label>
              <span style={{
                background: "rgba(255,106,0,0.15)",
                color: "#FF6A00", fontWeight: 800,
                fontSize: "13px", padding: "4px 10px",
                borderRadius: "8px",
              }}>{promocao}%</span>
            </div>
            <input
              ref={sliderRef}
              type="range" min={0} max={50} step={1}
              value={promocao}
              onChange={e => { setPromocao(Number(e.target.value)); setShowCustom(false); }}
              className="slider-promo"
            />
          </div>

          {/* ML status */}
          {marketplace === "ML" && (
            <div style={{ marginBottom: "16px" }}>
              {mlConectado === null ? (
                <span style={{ fontSize: "12px", color: "#9099aa" }}>Verificando conexão ML...</span>
              ) : mlConectado ? (
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "12px", color: "#4ade80", fontWeight: 600 }}>● ML conectado</span>
                  <a href="/api/auth/logout" style={{ fontSize: "11px", color: "#888", textDecoration: "underline" }}>Desconectar</a>
                </div>
              ) : (
                <a href="/api/auth/mercadolivre" style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  fontSize: "13px", background: "#FFE600", color: "#000",
                  padding: "8px 16px", borderRadius: "10px",
                  textDecoration: "none", fontWeight: 800,
                }}>Conectar ao Mercado Livre</a>
              )}
            </div>
          )}

          {/* Botão calcular */}
          <button style={{
            width: "100%", padding: "16px",
            background: "linear-gradient(135deg,#FF6A00,#ffb800)",
            border: "none", borderRadius: "14px",
            fontWeight: 900, fontSize: "15px", color: "#10131b",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="12" x2="15" y2="12"/></svg>
            Calcular Preço Ideal
          </button>
        </div>

        {/* ── Card 2: Resultado ──────────────────────────────────────────── */}
        <div style={{
          background: "#161921",
          border: "1px solid rgba(255,255,255,0.07)",
          borderRadius: "20px",
          padding: "24px",
          display: "flex",
          flexDirection: "column",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <div style={{ fontSize: "14px", fontWeight: 800, color: "#9099aa" }}>
              <span style={{
                background: "#FF6A00", color: "#fff",
                borderRadius: "50%", width: "22px", height: "22px",
                display: "inline-grid", placeItems: "center",
                fontSize: "12px", fontWeight: 900, marginRight: "8px",
              }}>2</span>
              Resultado da precificação
            </div>
            <button style={{
              padding: "8px 16px",
              background: "transparent",
              border: "1px solid rgba(255,106,0,0.4)",
              borderRadius: "10px",
              color: "#FF6A00",
              fontWeight: 700, fontSize: "13px",
              cursor: "pointer",
            }}>Salvar Cálculo</button>
          </div>

          {/* Preços em destaque */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "20px" }}>
            <div style={{
              background: "rgba(0,217,126,0.08)",
              border: "1px solid rgba(0,217,126,0.2)",
              borderRadius: "14px", padding: "16px",
            }}>
              <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Preço Ideal
              </div>
              <div style={{ fontSize: "28px", fontWeight: 900, color: "#00D97E" }}>
                {precoIdeal ? moeda(precoIdeal) : "—"}
              </div>
            </div>
            <div style={{
              background: promocao > 0 ? "rgba(255,106,0,0.08)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${promocao > 0 ? "rgba(255,106,0,0.2)" : "rgba(255,255,255,0.06)"}`,
              borderRadius: "14px", padding: "16px",
            }}>
              <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                Preço c/ Promoção {promocao > 0 ? `(${promocao}%)` : ""}
              </div>
              <div style={{ fontSize: "28px", fontWeight: 900, color: promocao > 0 ? "#FF6A00" : "#555" }}>
                {precoComPromocao ? moeda(precoComPromocao) : "—"}
              </div>
            </div>
          </div>

          {/* Breakdown */}
          {breakdownRows.length > 0 ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "1px" }}>
              {breakdownRows.map((row, i) => (
                <div key={i} style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 12px",
                  background: (row as any).destaque ? "rgba(255,255,255,0.04)" : "transparent",
                  borderRadius: "10px",
                  borderTop: (row as any).destaque ? "1px solid rgba(255,255,255,0.07)" : "none",
                }}>
                  <span style={{ fontSize: "13px", color: "#d7dbe5" }}>{row.label}</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "13px", fontWeight: 700, color: (row as any).destaque ? "#fff" : "#d7dbe5" }}>{row.val}</span>
                    <span style={{
                      fontSize: "11px", fontWeight: 800,
                      padding: "2px 8px", borderRadius: "6px",
                      background: row.positivo ? "rgba(0,217,126,0.15)" : "rgba(255,60,60,0.12)",
                      color: row.positivo ? "#00D97E" : "#ff6b6b",
                    }}>{row.pct}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              color: "#9099aa", fontSize: "14px", textAlign: "center", padding: "20px",
            }}>
              {marketplace === "ML" ? "Selecione uma categoria para ver o resultado" : "Preencha os dados para calcular"}
            </div>
          )}

          <p style={{ margin: "12px 0 0", fontSize: "11px", color: "#666", display: "flex", alignItems: "center", gap: "6px" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></svg>
            Os valores são aproximados e podem variar conforme as taxas.
          </p>
        </div>
      </div>

      {/* ── Seção 3: Cards de promoção ─────────────────────────────────── */}
      <div style={{
        background: "#161921",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "20px",
        padding: "24px",
      }}>
        <div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "14px", fontWeight: 800, color: "#9099aa" }}>
            <span style={{
              background: "#FF6A00", color: "#fff",
              borderRadius: "50%", width: "22px", height: "22px",
              display: "inline-grid", placeItems: "center",
              fontSize: "12px", fontWeight: 900, marginRight: "8px",
            }}>3</span>
            Preço para campanhas e promoções
          </div>
          <p style={{ margin: "6px 0 0 30px", fontSize: "12px", color: "#666" }}>
            Veja por quanto você deve anunciar para oferecer descontos sem perder sua margem desejada.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: "10px" }}>
          {PRESETS_PCT.map(pct => {
            const preco = precoIdeal ? precoIdeal / (1 - pct / 100) : null;
            const ativo = promocao === pct;
            return (
              <div
                key={pct}
                onClick={() => setPromocao(pct)}
                style={{
                  position: "relative",
                  background: ativo ? "rgba(255,106,0,0.1)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${ativo ? "#FF6A00" : "rgba(255,255,255,0.07)"}`,
                  borderRadius: "14px",
                  padding: "14px 10px",
                  cursor: "pointer",
                  transition: "all 0.15s",
                  textAlign: "center",
                }}
              >
                {ativo && (
                  <div style={{
                    position: "absolute", top: "-10px", left: "50%", transform: "translateX(-50%)",
                    background: "#FF6A00", color: "#fff",
                    fontSize: "9px", fontWeight: 800,
                    padding: "2px 8px", borderRadius: "999px",
                    whiteSpace: "nowrap",
                  }}>Selecionado</div>
                )}
                <div style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", marginBottom: "8px" }}>
                  {pct}% de desconto
                </div>
                <div style={{ fontSize: "10px", color: "#666", marginBottom: "4px" }}>Preço sugerido</div>
                <div style={{ fontSize: "16px", fontWeight: 900, color: "#FF6A00", marginBottom: "8px" }}>
                  {preco ? moeda(preco) : "—"}
                </div>
                <div style={{ fontSize: "10px", color: "#666", marginBottom: "2px" }}>Lucro líquido</div>
                <div style={{ fontSize: "12px", fontWeight: 800, color: "#00D97E" }}>
                  {lucroUnitario ? `${moeda(lucroUnitario)} (${margemDesejada}%)` : "—"}
                </div>
              </div>
            );
          })}

          {/* Card personalizar */}
          <div
            onClick={() => setShowCustom(true)}
            style={{
              background: showCustom ? "rgba(255,106,0,0.08)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${showCustom ? "#FF6A00" : "rgba(255,255,255,0.07)"}`,
              borderRadius: "14px",
              padding: "14px 10px",
              cursor: "pointer",
              textAlign: "center",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              gap: "6px",
            }}
          >
            {showCustom ? (
              <>
                <div style={{ fontSize: "10px", color: "#9099aa", fontWeight: 700 }}>Seu %</div>
                <input
                  type="number" min={0} max={80}
                  value={customPct}
                  onChange={e => setCustomPct(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && customPct) {
                      setPromocao(Number(customPct));
                      setShowCustom(false);
                    }
                  }}
                  onClick={e => e.stopPropagation()}
                  placeholder="ex: 35"
                  style={{
                    width: "60px", padding: "6px 8px",
                    borderRadius: "8px",
                    border: "1px solid rgba(255,106,0,0.5)",
                    background: "rgba(255,106,0,0.1)",
                    color: "#fff", fontSize: "13px",
                    textAlign: "center", outline: "none",
                  }}
                  autoFocus
                />
                <div style={{ fontSize: "9px", color: "#666" }}>Enter para aplicar</div>
              </>
            ) : (
              <>
                <div style={{
                  width: "32px", height: "32px",
                  borderRadius: "50%",
                  background: "rgba(255,106,0,0.1)",
                  display: "grid", placeItems: "center",
                  color: "#FF6A00", fontSize: "18px", fontWeight: 300,
                }}>+</div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa" }}>Personalizar</div>
                <div style={{ fontSize: "10px", color: "#666" }}>Definir outro percentual</div>
              </>
            )}
          </div>
        </div>

        <p style={{ margin: "16px 0 0", fontSize: "11px", color: "#555", display: "flex", alignItems: "center", gap: "6px" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.51"/></svg>
          Taxas atualizadas em 2026
        </p>
      </div>

      {/* ── Seção 4: Simulador "e se?" ─────────────────────────────────── */}
      <div style={{
        background: "#161921",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "20px",
        padding: "24px",
        marginTop: "20px",
      }}>
        {/* Header */}
        <div style={{ marginBottom: "20px" }}>
          <div style={{ fontSize: "14px", fontWeight: 800, color: "#9099aa", marginBottom: "4px" }}>
            <span style={{
              background: "#FF6A00", color: "#fff",
              borderRadius: "50%", width: "22px", height: "22px",
              display: "inline-grid", placeItems: "center",
              fontSize: "12px", fontWeight: 900, marginRight: "8px",
            }}>4</span>
            Simulador — E se?
          </div>
          <p style={{ margin: "6px 0 0 30px", fontSize: "12px", color: "#666" }}>
            Teste cenários sem alterar seu cálculo principal.
          </p>
        </div>

        {/* Toggle de modo */}
        <div style={{
          display: "inline-flex",
          background: "rgba(255,255,255,0.05)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "12px",
          padding: "4px",
          gap: "4px",
          marginBottom: "24px",
        }}>
          {([
            { key: "preco",  label: "💰 Se eu cobrar R$..." },
            { key: "margem", label: "🎯 Se eu quiser X% de margem..." },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => { setSimMode(key); setSimPreco(""); setSimMargem(""); }}
              style={{
                padding: "8px 18px", borderRadius: "9px", border: "none",
                background: simMode === key ? "linear-gradient(135deg,#FF6A00,#ffb800)" : "transparent",
                color: simMode === key ? "#10131b" : "#9099aa",
                fontWeight: 800, fontSize: "13px", cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", alignItems: "start" }}>
          {/* Input do simulador */}
          <div>
            {simMode === "preco" ? (
              <div>
                <label style={LABEL_STYLE}>Se eu cobrar este preço (R$)</label>
                <input
                  value={simPreco}
                  onChange={e => setSimPreco(e.target.value)}
                  placeholder="Ex: 89,90"
                  style={{ ...INPUT_STYLE, fontSize: "20px", fontWeight: 800, color: "#FFE600" }}
                />
                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#666" }}>
                  → Qual será minha margem e lucro com este preço?
                </p>
              </div>
            ) : (
              <div>
                <label style={LABEL_STYLE}>Se eu quiser esta margem (%)</label>
                <input
                  value={simMargem}
                  onChange={e => setSimMargem(e.target.value)}
                  placeholder="Ex: 35"
                  style={{ ...INPUT_STYLE, fontSize: "20px", fontWeight: 800, color: "#FFE600" }}
                />
                <p style={{ margin: "8px 0 0", fontSize: "12px", color: "#666" }}>
                  → Qual preço devo cobrar para atingir essa margem?
                </p>
              </div>
            )}

            {/* Referência atual */}
            {precoIdeal && (
              <div style={{
                marginTop: "16px",
                padding: "12px 14px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)",
                borderRadius: "12px",
                fontSize: "12px", color: "#9099aa",
              }}>
                <span style={{ fontWeight: 700 }}>Cálculo atual:</span>{" "}
                Preço ideal <span style={{ color: "#00D97E", fontWeight: 800 }}>{moeda(precoIdeal)}</span>{" "}
                com <span style={{ color: "#00D97E", fontWeight: 800 }}>{margemDesejada}%</span> de margem
              </div>
            )}
          </div>

          {/* Resultado do simulador */}
          <div>
            {simResultado ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {/* Métricas principais */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                  <div style={{
                    padding: "16px",
                    background: simResultado.mcPct >= 0 ? "rgba(0,217,126,0.08)" : "rgba(255,77,77,0.08)",
                    border: `1px solid ${simResultado.mcPct >= 0 ? "rgba(0,217,126,0.2)" : "rgba(255,77,77,0.2)"}`,
                    borderRadius: "14px",
                  }}>
                    <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, marginBottom: "6px", textTransform: "uppercase" }}>Margem</div>
                    <div style={{ fontSize: "26px", fontWeight: 900, color: simResultado.mcPct >= 0 ? "#00D97E" : "#ff4d4d" }}>
                      {simResultado.mcPct.toFixed(1)}%
                    </div>
                    {simResultado.diffMC !== null && (
                      <div style={{ fontSize: "11px", marginTop: "4px", color: simResultado.diffMC >= 0 ? "#00D97E" : "#ff4d4d", fontWeight: 700 }}>
                        {simResultado.diffMC >= 0 ? "▲" : "▼"} {Math.abs(simResultado.diffMC).toFixed(1)}pp vs atual
                      </div>
                    )}
                  </div>

                  <div style={{
                    padding: "16px",
                    background: simResultado.lucro >= 0 ? "rgba(111,163,255,0.08)" : "rgba(255,77,77,0.08)",
                    border: `1px solid ${simResultado.lucro >= 0 ? "rgba(111,163,255,0.2)" : "rgba(255,77,77,0.2)"}`,
                    borderRadius: "14px",
                  }}>
                    <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, marginBottom: "6px", textTransform: "uppercase" }}>
                      {simMode === "preco" ? "Preço simulado" : "Preço sugerido"}
                    </div>
                    <div style={{ fontSize: "22px", fontWeight: 900, color: "#6fa3ff" }}>
                      {moeda(simResultado.p)}
                    </div>
                    {simResultado.diffPreco !== null && (
                      <div style={{ fontSize: "11px", marginTop: "4px", color: simResultado.diffPreco >= 0 ? "#00D97E" : "#ff4d4d", fontWeight: 700 }}>
                        {simResultado.diffPreco >= 0 ? "▲" : "▼"} {moeda(Math.abs(simResultado.diffPreco))} vs atual
                      </div>
                    )}
                  </div>
                </div>

                {/* Breakdown simplificado */}
                <div style={{
                  padding: "14px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: "12px",
                  display: "flex", flexDirection: "column", gap: "6px",
                }}>
                  {[
                    { label: "Lucro líquido",  val: moeda(simResultado.lucro),    cor: simResultado.lucro >= 0 ? "#00D97E" : "#ff4d4d" },
                    { label: "Comissão",        val: moeda(simResultado.comissao), cor: "#ff6b6b" },
                    { label: "Imposto",         val: moeda(simResultado.impostoV), cor: "#ff6b6b" },
                    { label: "Custo produto",   val: moeda(parseN(custoProduto) + parseN(insumos)), cor: "#9099aa" },
                  ].map(({ label, val, cor }) => (
                    <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                      <span style={{ color: "#9099aa" }}>{label}</span>
                      <span style={{ fontWeight: 800, color: cor }}>{val}</span>
                    </div>
                  ))}
                </div>

                {/* Aviso se margem negativa */}
                {simResultado.mcPct < 0 && (
                  <div style={{
                    padding: "10px 14px",
                    background: "rgba(255,77,77,0.1)",
                    border: "1px solid rgba(255,77,77,0.25)",
                    borderRadius: "10px",
                    fontSize: "12px", color: "#ff6b6b", fontWeight: 700,
                  }}>
                    ⚠️ Você está vendendo abaixo do custo com este preço.
                  </div>
                )}
              </div>
            ) : (
              <div style={{
                height: "100%", minHeight: "160px",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#555", fontSize: "13px", textAlign: "center",
                border: "1px dashed rgba(255,255,255,0.08)",
                borderRadius: "14px", padding: "20px",
              }}>
                {simMode === "preco"
                  ? "Digite um preço para simular o resultado"
                  : "Digite uma margem desejada para simular"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
