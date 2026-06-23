"use client";
import { useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";
import { CATEGORIAS_ML, type TipoAnuncio } from "@/lib/comissoes-mercado-livre";
import {
  calcularFreteMl, calcularFreteFullMl, calcularFreteFlexMl,
  descricaoFaixaFrete, TAMANHOS_FULL, type TamanhoFull,
} from "@/lib/tabela-frete-ml";

interface Props {
  inicial: Anuncio | null;
  onSalvar: () => void;
  onFechar: () => void;
}

function parse(v: string) {
  return Number(String(v).replace(/\./g, "").replace(",", ".")) || 0;
}

type Etapa = "link" | "variacao" | "custos";

type VariacaoItem = { id: string; attributes: string; preco: number | null; thumbnail: string | null };

interface DadosML {
  id: string;
  titulo: string;
  preco: number | null;
  categoria: string | null;
  categoriaId: string | null;
  tipoAnuncio: string | null;
  thumbnail: string | null;
  permalink: string | null;
  sku: string | null;
  freteGratis: boolean;
  logisticType: string | null;
  variacoes?: VariacaoItem[];
  variacaoId?: string | null;
  parcial?: boolean;
}

export default function FormAnuncio({ inicial, onSalvar, onFechar }: Props) {
  const modoEdicao = !!inicial;
  const [etapa, setEtapa] = useState<Etapa>(modoEdicao ? "custos" : "link");

  // Link
  const [link,         setLink]         = useState("");
  const [variacaoLink, setVariacaoLink] = useState(""); // código da variação (opcional)
  const [buscando,     setBuscando]     = useState(false);
  const [erroLink,     setErroLink]     = useState("");
  const [dadosML,  setDadosML]  = useState<DadosML | null>(
    modoEdicao ? {
      id:          inicial?.ml_item_id ?? "",
      titulo:      inicial?.nome ?? "",
      preco:       inicial?.preco_anuncio ?? null,
      categoria:   inicial?.categoria ?? null,
      categoriaId: null,
      tipoAnuncio: inicial?.tipo_anuncio ?? null,
      thumbnail:   inicial?.thumbnail ?? null,
      permalink:   inicial?.permalink ?? null,
      sku:         null,
      freteGratis: inicial?.frete_gratis ?? false,
      logisticType: null,
      variacoes:   [],
      variacaoId:  null,
    } : null
  );

  // Nome manual — usado quando a API ML não retorna o título (ex: MLBU sem item_id)
  const [nomeManual, setNomeManual] = useState(inicial?.nome ?? "");

  // Preço manual — usado quando a API ML não retorna o preço (ex: itens MLBU/catálogo)
  const [precoManual, setPrecoManual] = useState(
    inicial?.preco_anuncio ? String(inicial.preco_anuncio).replace(".", ",") : ""
  );

  // SKU — pré-preenchido da API ou editável manualmente
  const [skuManual, setSkuManual] = useState(
    inicial?.sku ?? dadosML?.sku ?? ""
  );

  // Apenas 3 campos manuais
  const [custoProduto, setCustoProduto] = useState(
    inicial?.custo_produto ? String(inicial.custo_produto).replace(".", ",") : ""
  );
  const [imposto, setImposto] = useState(() => {
    // Modo edição: usa o valor salvo no anúncio
    if (inicial) return String(inicial.imposto ?? 8);
    // Novo anúncio: usa o último valor salvo, senão 8%
    if (typeof window !== "undefined") {
      const salvo = localStorage.getItem("cds_imposto_padrao");
      if (salvo) return salvo;
    }
    return "8";
  });
  const [custoFrete, setCustoFrete] = useState(
    inicial?.custo_frete ? String(inicial.custo_frete).replace(".", ",") : ""
  );
  const [freteGratis, setFreteGratis] = useState(inicial?.frete_gratis ?? false);
  const [pesoKg, setPesoKg] = useState(
    inicial?.peso_kg ? String(inicial.peso_kg).replace(".", ",") : ""
  );
  const [freteOverride, setFreteOverride] = useState(false);
  type TipoEnvio = "ME2" | "Full" | "Flex";
  const [tipoEnvio, setTipoEnvio] = useState<TipoEnvio>("ME2");
  const [tamanhoFull, setTamanhoFull] = useState<TamanhoFull>("P");
  const [tamanhoME2, setTamanhoME2] = useState<TamanhoFull | null>(null);
  const [tipoAnuncio, setTipoAnuncio] = useState<TipoAnuncio>(
    (inicial?.tipo_anuncio as TipoAnuncio) ?? "Clássico"
  );

  const [salvando,       setSalvando]       = useState(false);
  const [erro,           setErro]           = useState("");
  const [adicionarTodas, setAdicionarTodas] = useState(false);

  // ── Buscar link ──────────────────────────────────────────────────────────
  async function buscarLink() {
    if (!link.trim()) { setErroLink("Cole o link do anúncio."); return; }
    setBuscando(true);
    setErroLink("");
    try {
      const varQuery = variacaoLink.trim()
        ? `&variationId=${encodeURIComponent(variacaoLink.trim())}`
        : "";
      const res  = await fetch(`/api/anuncio?link=${encodeURIComponent(link.trim())}${varQuery}`);
      const data = await res.json();
      if (data.erro) { setErroLink(data.mensagem); setBuscando(false); return; }
      if (data.tipoAnuncio === "Premium") setTipoAnuncio("Premium");
      else setTipoAnuncio("Clássico");
      if (data.freteGratis !== undefined) setFreteGratis(data.freteGratis);
      if (data.sku) setSkuManual(data.sku);

      // Auto-detecta tipo de envio pelo logistic_type do ML
      if (data.logisticType) {
        let novoTipo: TipoEnvio = "ME2";
        if (data.logisticType === "fulfillment") novoTipo = "Full";
        else if (data.logisticType === "self_service") novoTipo = "Flex";
        setTipoEnvio(novoTipo);
        const preco = data.preco ?? null;
        const calc =
          novoTipo === "Full" ? calcularFreteFullMl(tamanhoFull, preco) :
          novoTipo === "Flex" ? calcularFreteFlexMl(preco) :
          calcularFreteMl(pesoKgNum, preco);
        if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
      }

      setDadosML(data);

      // Se tem mais de 1 variação e nenhuma foi pré-selecionada → mostra picker
      if ((data.variacoes?.length ?? 0) > 1 && !variacaoLink.trim()) {
        setEtapa("variacao");
      } else {
        setEtapa("custos");
      }
    } catch {
      setErroLink("Erro ao buscar o anúncio. Tente novamente.");
    }
    setBuscando(false);
  }

  // ── Aplicar variação selecionada ──────────────────────────────────────────
  function aplicarVariacao(v: VariacaoItem) {
    if (!dadosML) return;
    // Remove sufixo de variação anterior do título base
    const baseTitle = dadosML.titulo.includes(" — ")
      ? dadosML.titulo.split(" — ")[0]
      : dadosML.titulo;
    const novoPreco = v.preco ?? dadosML.preco;
    setDadosML({
      ...dadosML,
      titulo:    `${baseTitle} — ${v.attributes}`,
      preco:     novoPreco,
      thumbnail: v.thumbnail ?? dadosML.thumbnail,
      variacaoId: v.id,
    });
    // Recalcula frete com o preço da variação
    if (!freteOverride) {
      const calc =
        tipoEnvio === "Full" ? calcularFreteFullMl(tamanhoFull, novoPreco) :
        tipoEnvio === "Flex" ? calcularFreteFlexMl(novoPreco) :
        calcularFreteMl(pesoKgNum, novoPreco);
      if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
    }
    setEtapa("custos");
  }

  // Preço efetivo: da API ML ou digitado manualmente
  const precoEfetivo = dadosML?.preco ?? (parse(precoManual) || null);

  // Frete auto-calculado conforme tipo de envio
  const pesoKgNum = parse(pesoKg) || null;
  const freteAutoCalc =
    tipoEnvio === "Full"  ? calcularFreteFullMl(tamanhoFull, precoEfetivo) :
    tipoEnvio === "Flex"  ? calcularFreteFlexMl(precoEfetivo) :
    /* ME2 */               calcularFreteMl(pesoKgNum, precoEfetivo);

  // Quando tipo de envio muda, sincroniza o campo custo frete
  // (feito nos handlers dos botões abaixo)
  // O vendedor SEMPRE paga o frete ao ML, mesmo quando é grátis para o comprador.
  // freteGratis = true significa que o COMPRADOR não paga — o vendedor ainda tem custo.
  const custoFreteEfetivo = parse(custoFrete);

  // ── Calcular resultado ────────────────────────────────────────────────────
  function calcResultado() {
    const preco = precoEfetivo;
    if (!preco || preco <= 0) return null;

    const cp  = parse(custoProduto);
    if (cp <= 0) return null;
    const imp = (Number(imposto) || 0) / 100;
    const cf  = custoFreteEfetivo;

    const cat = CATEGORIAS_ML.find(
      c => c.nome.toLowerCase() === (dadosML?.categoria ?? "").toLowerCase()
    );
    // Usa taxa padrão quando categoria não é encontrada (subcategorias do ML não mapeadas)
    const comissaoRate = tipoAnuncio === "Premium"
      ? (cat?.premium ?? 0.18)
      : (cat?.classico ?? 0.13);
    const comissaoVal  = preco * comissaoRate;
    const impostoVal   = preco * imp;
    const lucro        = preco - comissaoVal - impostoVal - cf - cp;

    return { preco, comissaoVal, impostoVal, freteVal: cf, cp, lucro, margem: (lucro / preco) * 100 };
  }

  // ── Salvar ────────────────────────────────────────────────────────────────
  // Calcula frete ajustado para um preço específico (respeita override manual)
  function calcFreteParaPreco(preco: number | null): number {
    if (freteOverride) return parse(custoFrete);
    const calc =
      tipoEnvio === "Full" ? calcularFreteFullMl(tamanhoFull, preco) :
      tipoEnvio === "Flex" ? calcularFreteFlexMl(preco) :
      calcularFreteMl(pesoKgNum, preco);
    return calc ?? parse(custoFrete);
  }

  async function salvar() {
    if (!custoProduto || parse(custoProduto) <= 0) {
      setErro("Informe o custo do produto.");
      return;
    }
    setSalvando(true);
    setErro("");
    if (typeof window !== "undefined") {
      localStorage.setItem("cds_imposto_padrao", imposto);
    }

    const cp = parse(custoProduto);
    const imp = (Number(imposto) || 0) / 100;
    const cat = CATEGORIAS_ML.find(c => c.nome.toLowerCase() === (dadosML?.categoria ?? "").toLowerCase());
    const comissaoRate = tipoAnuncio === "Premium" ? (cat?.premium ?? 0.18) : (cat?.classico ?? 0.13);

    function montarPayload(titulo: string, preco: number | null, thumbnail: string | null, variationId: string | null) {
      const cf = calcFreteParaPreco(preco);
      const comissaoVal = (preco ?? 0) * comissaoRate;
      const impostoVal  = (preco ?? 0) * imp;
      const lucro       = (preco ?? 0) - comissaoVal - impostoVal - cf - cp;
      const margem      = preco ? (lucro / preco) * 100 : 0;
      return {
        nome:              titulo,
        marketplace:       "ML" as const,
        categoria:         dadosML?.categoria ?? null,
        tipo_anuncio:      tipoAnuncio,
        tipo_conta_shopee: null,
        custo_produto:     cp,
        insumos:           0,
        custo_frete:       cf,
        frete_gratis:      freteGratis,
        imposto:           Number(imposto) || 0,
        margem_desejada:   Math.round(margem * 100) / 100,
        preco_ideal:       null,
        preco_anuncio:     preco,
        sku:               skuManual.trim() || dadosML?.sku || null,
        peso_kg:           pesoKgNum,
        ml_item_id:        dadosML?.id ?? null,
        variation_id:      variationId,
        thumbnail,
        permalink:         dadosML?.permalink ?? null,
        ativo:             true,
      };
    }

    // ── Modo "adicionar todas as variações" ──────────────────────────────────
    if (adicionarTodas && dadosML?.variacoes?.length) {
      const baseTitle = (dadosML.titulo ?? "").split(" — ")[0] || dadosML.titulo || nomeManual || link;
      for (const v of dadosML.variacoes) {
        const payload = montarPayload(
          `${baseTitle} — ${v.attributes}`,
          v.preco ?? dadosML.preco,
          v.thumbnail ?? dadosML.thumbnail ?? null,
          v.id,
        );
        await supabase.from("anuncios").insert(payload);
      }
      setSalvando(false);
      onSalvar();
      return;
    }

    // ── Modo normal (único anúncio) ──────────────────────────────────────────
    const r = calcResultado();
    const payload = montarPayload(
      dadosML?.titulo || nomeManual || link,
      precoEfetivo,
      dadosML?.thumbnail ?? null,
      dadosML?.variacaoId ?? null,
    );
    // Garante margem_desejada do calcResultado quando disponível
    if (r) (payload as any).margem_desejada = Math.round(r.margem * 100) / 100;

    if (inicial) {
      await supabase.from("anuncios").update(payload).eq("id", inicial.id);
    } else {
      await supabase.from("anuncios").insert(payload);
    }
    setSalvando(false);
    onSalvar();
  }

  const resultado = calcResultado();
  const moeda = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

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
      <div style={{ background: "#0d1220", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "28px", padding: "32px", width: "100%", maxWidth: "480px", maxHeight: "92vh", overflowY: "auto" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "24px" }}>
          <div>
            <h2 style={{ margin: 0, fontSize: "20px" }}>
              {modoEdicao ? "Editar Anúncio" : etapa === "link" ? "Novo Anúncio" : etapa === "variacao" ? "Selecionar Variação" : "Informar Custos"}
            </h2>
            <p style={{ margin: "4px 0 0", color: "#9099aa", fontSize: "13px" }}>
              {etapa === "link" ? "Cole o link ou código do anúncio no Mercado Livre" : etapa === "variacao" ? `${dadosML?.variacoes?.length ?? 0} variações disponíveis — escolha uma` : "Informe seus custos para ver o valor líquido"}
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
                placeholder="Link, MLB ou código (ex: 2115083718)"
                style={{ ...inputStyle, flex: 1, border: erroLink ? "1.5px solid #ff4d4d" : "1.5px solid rgba(255,255,255,0.12)" }}
              />
              <button onClick={buscarLink} disabled={buscando} style={{
                padding: "13px 18px", whiteSpace: "nowrap",
                background: buscando ? "rgba(255,255,255,0.08)" : "linear-gradient(135deg,#ff6b00,#ffb800)",
                border: "none", borderRadius: "14px", fontWeight: 800,
                color: buscando ? "#9099aa" : "#10131b", cursor: buscando ? "not-allowed" : "pointer", fontSize: "14px",
              }}>
                {buscando ? "⏳" : "🔍 Buscar"}
              </button>
            </div>
            {erroLink && <p style={{ color: "#ff4d4d", fontSize: "13px", margin: "4px 0 0" }}>{erroLink}</p>}

            {/* Campo de variação (opcional) */}
            <div style={{ marginTop: "14px" }}>
              <span style={{ ...labelStyle, marginBottom: "7px" }}>CÓDIGO DA VARIAÇÃO (opcional)</span>
              <input
                value={variacaoLink}
                onChange={e => setVariacaoLink(e.target.value)}
                onKeyDown={e => e.key === "Enter" && buscarLink()}
                placeholder="Ex: 175706413780 — cor, tamanho, modelo..."
                style={{ ...inputStyle }}
              />
              <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "5px" }}>
                💡 Se o anúncio tem variações, informe o código aqui — ou deixe em branco para ver todas as opções.
              </div>
            </div>
          </div>
        )}

        {/* ── ETAPA 1.5: Picker de variação ── */}
        {etapa === "variacao" && dadosML?.variacoes && (
          <div>
            {/* Preview do produto base */}
            <div style={{ display: "flex", gap: "12px", alignItems: "center", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "14px", padding: "12px", marginBottom: "18px" }}>
              {dadosML.thumbnail && (
                <img src={dadosML.thumbnail.replace("http://", "https://")} alt="" style={{ width: "44px", height: "44px", objectFit: "contain", borderRadius: "8px", background: "#fff", flexShrink: 0 }} />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: "13px", lineHeight: 1.3 }}>{dadosML.titulo}</div>
                {dadosML.preco && <div style={{ color: "#9099aa", fontSize: "12px", marginTop: "2px" }}>Preço base: R$ {dadosML.preco.toFixed(2).replace(".", ",")}</div>}
              </div>
            </div>

            {/* Botão principal: adicionar todas de uma vez */}
            <button
              onClick={() => { setAdicionarTodas(true); setEtapa("custos"); }}
              style={{
                width: "100%", padding: "14px", marginBottom: "14px",
                background: "linear-gradient(135deg,#ff6b00,#ffb800)",
                border: "none", borderRadius: "14px", fontWeight: 900, fontSize: "15px",
                color: "#10131b", cursor: "pointer",
              }}
            >
              ➕ Adicionar todas as {dadosML.variacoes.length} variações
            </button>

            {/* Ou seleciona uma específica */}
            <div style={{ fontSize: "11px", color: "#9099aa", fontWeight: 700, letterSpacing: "0.5px", marginBottom: "10px", textAlign: "center" }}>
              — OU SELECIONE UMA ESPECÍFICA —
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "18px" }}>
              {dadosML.variacoes.map(v => (
                <button
                  key={v.id}
                  onClick={() => { setAdicionarTodas(false); aplicarVariacao(v); }}
                  style={{
                    display: "flex", alignItems: "center", gap: "12px",
                    padding: "11px 14px", borderRadius: "14px", width: "100%",
                    border: "1.5px solid rgba(255,255,255,0.1)",
                    background: "rgba(255,255,255,0.04)", cursor: "pointer", textAlign: "left",
                  }}
                >
                  {v.thumbnail ? (
                    <img
                      src={v.thumbnail}
                      alt=""
                      style={{ width: "42px", height: "42px", objectFit: "contain", borderRadius: "8px", background: "#fff", flexShrink: 0 }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div style={{ width: "42px", height: "42px", borderRadius: "8px", background: "rgba(255,255,255,0.07)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: "18px" }}>📦</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: 700, color: "#fff", lineHeight: 1.3 }}>{v.attributes}</div>
                    {v.preco !== null && (
                      <div style={{ fontSize: "12px", color: "#00D97E", fontWeight: 700, marginTop: "2px" }}>
                        R$ {v.preco.toFixed(2).replace(".", ",")}
                      </div>
                    )}
                    <div style={{ fontSize: "10px", color: "#555d6b", marginTop: "1px" }}>ID: {v.id}</div>
                  </div>
                  <span style={{ color: "#6fa3ff", fontSize: "16px", flexShrink: 0 }}>→</span>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", gap: "10px" }}>
              <button onClick={() => setEtapa("link")} style={{ padding: "13px 18px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "14px", color: "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "14px" }}>
                ← Voltar
              </button>
              <button onClick={() => { setAdicionarTodas(false); setEtapa("custos"); }} style={{ flex: 1, padding: "13px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "14px", color: "#9099aa", fontWeight: 600, cursor: "pointer", fontSize: "13px" }}>
                Pular — sem variação
              </button>
            </div>
          </div>
        )}

        {/* ── ETAPA 2: Custos ── */}
        {etapa === "custos" && (
          <div>
            {/* Preview do produto */}
            {dadosML && (
              <div style={{ display: "flex", gap: "14px", alignItems: "center", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px", padding: "14px", marginBottom: "24px" }}>
                {dadosML.thumbnail && (
                  <img src={dadosML.thumbnail.replace("http://", "https://")} alt="" style={{ width: "52px", height: "52px", objectFit: "contain", borderRadius: "10px", background: "#fff", flexShrink: 0 }} />
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: "14px", lineHeight: 1.3, marginBottom: "4px" }}>{dadosML.titulo}</div>
                  <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ background: "rgba(255,230,0,0.15)", color: "#FFE600", fontSize: "11px", fontWeight: 800, borderRadius: "6px", padding: "2px 8px" }}>
                      {tipoAnuncio}
                    </span>
                    {dadosML.categoria && <span style={{ color: "#9099aa", fontSize: "12px" }}>{dadosML.categoria}</span>}
                    {dadosML.preco && <span style={{ color: "#00D97E", fontSize: "13px", fontWeight: 700 }}>{moeda(dadosML.preco)}</span>}
                  </div>
                  {dadosML.sku && (
                    <div style={{ marginTop: "4px" }}>
                      <span style={{ fontSize: "11px", color: "#9099aa" }}>SKU: </span>
                      <span style={{ fontSize: "11px", fontFamily: "monospace", fontWeight: 700, color: "#d7dbe5" }}>{dadosML.sku}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Tipo anúncio — caso não venha do link */}
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

            {/* Tipo de envio */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>TIPO DE ENVIO</span>
              <div style={{ display: "flex", gap: "8px" }}>
                {(["ME2", "Full", "Flex"] as const).map(t => (
                  <button key={t} onClick={() => {
                    setTipoEnvio(t);
                    setFreteOverride(false);
                    if (t === "ME2") setTamanhoME2(null);
                    // Recalcula frete ao trocar tipo
                    const calc =
                      t === "Full" ? calcularFreteFullMl(tamanhoFull, precoEfetivo) :
                      t === "Flex" ? calcularFreteFlexMl(precoEfetivo) :
                      calcularFreteMl(pesoKgNum, precoEfetivo);
                    if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
                  }} style={{
                    flex: 1, padding: "10px 6px", borderRadius: "12px", border: "2px solid",
                    borderColor: tipoEnvio === t ? "#6fa3ff" : "rgba(255,255,255,0.12)",
                    background: tipoEnvio === t ? "rgba(100,160,255,0.1)" : "rgba(255,255,255,0.04)",
                    color: tipoEnvio === t ? "#6fa3ff" : "#9099aa",
                    fontWeight: 700, cursor: "pointer", fontSize: "13px",
                  }}>
                    {t === "ME2" ? "📦 ME2/Coleta" : t === "Full" ? "🏭 Full" : "🛵 Flex"}
                  </button>
                ))}
              </div>
            </div>

            {/* ME2: seletor de tamanho + campo de peso */}
            {tipoEnvio === "ME2" && (
              <div style={{ marginBottom: "16px" }}>
                <span style={labelStyle}>TAMANHO DO PRODUTO (embalagem)</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "10px" }}>
                  {(Object.entries(TAMANHOS_FULL) as [TamanhoFull, typeof TAMANHOS_FULL[TamanhoFull]][]).map(([key, val]) => (
                    <button key={key} onClick={() => {
                      setTamanhoME2(key);
                      setFreteOverride(false);
                      const pesoStr = String(val.pesoKg).replace(".", ",");
                      setPesoKg(pesoStr);
                      const calc = calcularFreteMl(val.pesoKg, precoEfetivo);
                      if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
                    }} style={{
                      padding: "10px 12px", borderRadius: "12px", border: "2px solid", textAlign: "left",
                      borderColor: tamanhoME2 === key ? "#6fa3ff" : "rgba(255,255,255,0.12)",
                      background: tamanhoME2 === key ? "rgba(100,160,255,0.1)" : "rgba(255,255,255,0.04)",
                      color: tamanhoME2 === key ? "#6fa3ff" : "#9099aa",
                      fontWeight: 700, cursor: "pointer",
                    }}>
                      <div style={{ fontSize: "13px" }}>{val.label} ({key})</div>
                      <div style={{ fontSize: "10px", fontWeight: 400, marginTop: "2px" }}>{val.desc}</div>
                    </button>
                  ))}
                </div>
                <span style={{ ...labelStyle, marginTop: "4px" }}>PESO NA EMBALAGEM (kg)</span>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <input
                    value={pesoKg}
                    onChange={e => {
                      setPesoKg(e.target.value);
                      setTamanhoME2(null);
                      setFreteOverride(false);
                      const p = parse(e.target.value) || null;
                      const calc = calcularFreteMl(p, precoEfetivo);
                      if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
                    }}
                    placeholder="Ex: 0,3"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  {freteAutoCalc !== null && !freteOverride && (
                    <div style={{ whiteSpace: "nowrap", fontSize: "12px", color: "#00D97E", fontWeight: 700 }}>
                      🚚 R$ {freteAutoCalc.toFixed(2).replace(".", ",")}
                    </div>
                  )}
                </div>
                {freteAutoCalc !== null && precoEfetivo && (
                  <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "5px" }}>
                    {descricaoFaixaFrete(precoEfetivo)} — tabela oficial ML
                  </div>
                )}
                {!pesoKg && (
                  <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "5px" }}>
                    💡 Selecione um tamanho ou informe o peso exato para calcular o frete.
                  </div>
                )}
              </div>
            )}

            {/* Full: seletor de tamanho */}
            {tipoEnvio === "Full" && (
              <div style={{ marginBottom: "16px" }}>
                <span style={labelStyle}>TAMANHO DO PRODUTO (embalagem)</span>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                  {(Object.entries(TAMANHOS_FULL) as [TamanhoFull, typeof TAMANHOS_FULL[TamanhoFull]][]).map(([key, val]) => (
                    <button key={key} onClick={() => {
                      setTamanhoFull(key);
                      setFreteOverride(false);
                      const calc = calcularFreteFullMl(key, precoEfetivo);
                      if (calc !== null) setCustoFrete(String(calc).replace(".", ","));
                    }} style={{
                      padding: "10px 12px", borderRadius: "12px", border: "2px solid", textAlign: "left",
                      borderColor: tamanhoFull === key ? "#6fa3ff" : "rgba(255,255,255,0.12)",
                      background: tamanhoFull === key ? "rgba(100,160,255,0.1)" : "rgba(255,255,255,0.04)",
                      color: tamanhoFull === key ? "#6fa3ff" : "#9099aa",
                      fontWeight: 700, cursor: "pointer",
                    }}>
                      <div style={{ fontSize: "13px" }}>{val.label} ({key})</div>
                      <div style={{ fontSize: "10px", fontWeight: 400, marginTop: "2px" }}>{val.desc}</div>
                    </button>
                  ))}
                </div>
                {freteAutoCalc !== null && precoEfetivo && (
                  <div style={{ fontSize: "11px", color: "#00D97E", marginTop: "8px", fontWeight: 700 }}>
                    🏭 Custo estimado: R$ {freteAutoCalc.toFixed(2).replace(".", ",")} — tabela ML
                  </div>
                )}
              </div>
            )}

            {/* Flex: informativo */}
            {tipoEnvio === "Flex" && precoEfetivo && (
              <div style={{ marginBottom: "16px", background: "rgba(100,160,255,0.05)", border: "1px solid rgba(100,160,255,0.15)", borderRadius: "14px", padding: "12px 14px" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#6fa3ff", marginBottom: "4px" }}>
                  🛵 Envios Flex — custo calculado automaticamente
                </div>
                {precoEfetivo >= 79 ? (
                  <div style={{ fontSize: "12px", color: "#9099aa" }}>
                    Produto ≥ R$79 → comprador paga o frete, você recebe de volta. <strong style={{ color: "#00D97E" }}>Custo líquido: R$0,00</strong>
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "#9099aa" }}>
                    Produto {"<"} R$79 → custo fixo por venda: <strong style={{ color: "#ff6b6b" }}>R$ {calcularFreteFlexMl(precoEfetivo).toFixed(2).replace(".", ",")}</strong>
                  </div>
                )}
              </div>
            )}

            {/* Frete para o comprador */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>FRETE PARA O COMPRADOR</span>
              <div style={{ display: "flex", gap: "10px" }}>
                <button onClick={() => setFreteGratis(false)} style={{
                  flex: 1, padding: "11px", borderRadius: "12px", border: "2px solid",
                  borderColor: !freteGratis ? "#FFE600" : "rgba(255,255,255,0.12)",
                  background: !freteGratis ? "rgba(255,230,0,0.1)" : "rgba(255,255,255,0.04)",
                  color: !freteGratis ? "#FFE600" : "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "13px",
                }}>📦 Por conta do comprador</button>
                <button onClick={() => setFreteGratis(true)} style={{
                  flex: 1, padding: "11px", borderRadius: "12px", border: "2px solid",
                  borderColor: freteGratis ? "#00D97E" : "rgba(255,255,255,0.12)",
                  background: freteGratis ? "rgba(0,217,126,0.1)" : "rgba(255,255,255,0.04)",
                  color: freteGratis ? "#00D97E" : "#9099aa", fontWeight: 700, cursor: "pointer", fontSize: "13px",
                }}>🚚 Grátis</button>
              </div>
            </div>

            {/* Custo do frete — manual override ou auto */}
            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "7px" }}>
                <span style={labelStyle}>CUSTO DO FRETE (R$) — você paga ao ML</span>
                {freteAutoCalc !== null && (
                  <button
                    onClick={() => {
                      setFreteOverride(!freteOverride);
                      if (freteOverride) setCustoFrete(String(freteAutoCalc).replace(".", ","));
                    }}
                    style={{ background: "none", border: "none", fontSize: "11px", color: freteOverride ? "#ff6b00" : "#9099aa", cursor: "pointer", fontWeight: 700 }}
                  >
                    {freteOverride ? "← usar tabela ML" : "editar manualmente"}
                  </button>
                )}
              </div>
              {freteGratis && (
                <div style={{ fontSize: "11px", color: "#9099aa", marginBottom: "6px" }}>
                  💡 Frete grátis ao comprador — mas <strong style={{ color: "#fff" }}>você ainda paga ao ML</strong>. Informe o custo real abaixo.
                </div>
              )}
              <input
                value={custoFrete}
                onChange={e => { setCustoFrete(e.target.value); setFreteOverride(true); }}
                placeholder="0,00"
                style={{
                  ...inputStyle,
                  background: freteAutoCalc !== null && !freteOverride ? "rgba(0,217,126,0.05)" : "rgba(255,255,255,0.05)",
                  borderColor: freteAutoCalc !== null && !freteOverride ? "rgba(0,217,126,0.3)" : "rgba(255,255,255,0.12)",
                }}
              />
            </div>

            {/* Nome manual — só aparece quando a API não retornou título */}
            {!dadosML?.titulo && (
              <div style={{ marginBottom: "16px" }}>
                <span style={labelStyle}>NOME DO ANÚNCIO *</span>
                <input
                  value={nomeManual}
                  onChange={e => setNomeManual(e.target.value)}
                  placeholder="Ex: Salon Pro Removedor Cola Kit"
                  style={{ ...inputStyle, borderColor: "rgba(255,230,0,0.4)" }}
                />
                <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "5px" }}>
                  💡 Nome não detectado automaticamente. Informe o nome do anúncio.
                </div>
              </div>
            )}

            {/* Preço manual — só aparece quando a API não retornou preço */}
            {!dadosML?.preco && (
              <div style={{ marginBottom: "16px" }}>
                <span style={labelStyle}>PREÇO DE VENDA (R$) *</span>
                <input
                  value={precoManual}
                  onChange={e => setPrecoManual(e.target.value)}
                  placeholder="Ex: 49,90"
                  style={{ ...inputStyle, borderColor: "rgba(255,230,0,0.4)" }}
                />
                <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "5px" }}>
                  💡 O preço não foi detectado automaticamente. Informe o preço atual do anúncio.
                </div>
              </div>
            )}

            {/* SKU */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>SKU (código interno)</span>
              <input
                value={skuManual}
                onChange={e => setSkuManual(e.target.value)}
                placeholder="Ex: CLED01SUN5ROS"
                style={inputStyle}
              />
            </div>

            {/* 3 campos do seller */}
            <div style={{ marginBottom: "16px" }}>
              <span style={labelStyle}>CUSTO DO PRODUTO (R$) *</span>
              <input value={custoProduto} onChange={e => setCustoProduto(e.target.value)} placeholder="Ex: 15,90" style={inputStyle} />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <span style={labelStyle}>IMPOSTO (%)</span>
              <input value={imposto} onChange={e => setImposto(e.target.value)} placeholder="8" style={inputStyle} />
            </div>

            {/* ── Resultado ── */}
            {resultado ? (
              <div style={{ background: resultado.lucro >= 0 ? "rgba(0,217,126,0.06)" : "rgba(255,60,60,0.06)", border: `1px solid ${resultado.lucro >= 0 ? "rgba(0,217,126,0.22)" : "rgba(255,60,60,0.22)"}`, borderRadius: "18px", padding: "18px", marginBottom: "20px" }}>
                {/* Faturamento */}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", paddingBottom: "10px", borderBottom: "1px solid rgba(255,255,255,0.07)", marginBottom: "8px" }}>
                  <span style={{ fontWeight: 700 }}>Preço anunciado</span>
                  <span style={{ fontWeight: 800 }}>{moeda(resultado.preco)}</span>
                </div>
                {/* Deduções */}
                {[
                  { label: `Comissão ML (${tipoAnuncio})`, val: resultado.comissaoVal },
                  { label: `Imposto (${imposto}%)`,         val: resultado.impostoVal },
                  ...(resultado.freteVal > 0 ? [{ label: freteGratis ? "🚚 Frete (você paga ao ML)" : "Taxa de frete", val: resultado.freteVal }] : []),
                  { label: "Custo do produto",             val: resultado.cp },
                ].filter(i => i.val > 0).map(({ label, val }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", marginBottom: "6px" }}>
                    <span style={{ color: "#9099aa" }}>{label}</span>
                    <span style={{ fontWeight: 700, color: "#ff6b6b" }}>− {moeda(val)}</span>
                  </div>
                ))}
                {/* Valor líquido */}
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: "10px", borderTop: "1px solid rgba(255,255,255,0.07)", marginTop: "4px" }}>
                  <span style={{ fontWeight: 800, fontSize: "15px" }}>💰 Valor líquido</span>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 900, fontSize: "22px", color: resultado.lucro >= 0 ? "#00D97E" : "#ff4d4d" }}>
                      {moeda(resultado.lucro)}
                    </div>
                    <div style={{ fontSize: "11px", color: resultado.lucro >= 0 ? "#00D97E" : "#ff4d4d", fontWeight: 700 }}>
                      {resultado.margem.toFixed(1)}% de margem
                    </div>
                  </div>
                </div>
              </div>
            ) : dadosML?.preco && (
              <div style={{ background: "rgba(255,180,0,0.06)", border: "1px solid rgba(255,180,0,0.15)", borderRadius: "14px", padding: "12px 16px", marginBottom: "20px", color: "#9099aa", fontSize: "13px" }}>
                💡 Informe o custo do produto para ver o valor líquido.
              </div>
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
                {salvando
                  ? (adicionarTodas ? `Salvando variações...` : "Salvando...")
                  : modoEdicao
                    ? "Salvar alterações"
                    : adicionarTodas
                      ? `✅ Cadastrar ${dadosML?.variacoes?.length ?? ""} variações`
                      : "✅ Cadastrar Anúncio"
                }
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
