"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase, type Anuncio } from "@/lib/supabase";
import { moeda } from "@/lib/cds-engine";
import FormAnuncio from "./FormAnuncio";
import CardAnuncio from "./CardAnuncio";
import CardAnuncioVariacoes from "./CardAnuncioVariacoes";

export default function AnunciosPage() {
  const [anuncios,    setAnuncios]    = useState<Anuncio[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [editando,    setEditando]    = useState<Anuncio | null>(null);
  const [mlConectado, setMlConectado] = useState(false);
  const [userId,      setUserId]      = useState<string | null>(null);

  // ── Filtros ─────────────────────────────────────────────────────────────
  const [painelFiltros,      setPainelFiltros]      = useState(false);
  const [busca,              setBusca]              = useState("");
  const [filtroDuplicados,   setFiltroDuplicados]   = useState(false);
  const [filtroMarketplace,  setFiltroMarketplace]  = useState<"todos" | "ML" | "Shopee">("todos");
  const [filtroVariacao,     setFiltroVariacao]      = useState(false);
  const [filtroLogistic,     setFiltroLogistic]      = useState<"" | "full" | "coleta">("" as "" | "full" | "coleta");

  // ── Ações ────────────────────────────────────────────────────────────────
  const [atualizandoSkus,    setAtualizandoSkus]    = useState(false);
  const [msgSkus,            setMsgSkus]            = useState<{ ok: boolean; texto: string } | null>(null);
  const [deletandoDuplicados, setDeletandoDuplicados] = useState(false);
  const [sincronizando,      setSincronizando]      = useState(false);
  const [modoSelecao,        setModoSelecao]        = useState(false);
  const [selectedIds,        setSelectedIds]        = useState<Set<string>>(new Set());
  const [deletandoSelecionados, setDeletandoSelecionados] = useState(false);
  const [msgSync,            setMsgSync]            = useState<{ ok: boolean; texto: string; detalhes?: string[] } | null>(null);
  const [importando,         setImportando]         = useState(false);
  const [msgImport,          setMsgImport]          = useState<{ ok: boolean; texto: string } | null>(null);

  async function carregar(uid?: string | null) {
    setLoading(true);
    const id = uid ?? userId;
    if (!id) { setLoading(false); return; }
    const { data } = await supabase
      .from("anuncios")
      .select("*")
      .eq("ativo", true)
      .eq("user_id", id)
      .order("created_at", { ascending: false });
    if (data) setAnuncios(data as Anuncio[]);
    setLoading(false);
  }

  useEffect(() => {
    // Busca user_id e ML status em paralelo
    Promise.all([
      fetch("/api/auth/me").then(r => r.json()).catch(() => ({ userId: null })),
      fetch("/api/auth/status").then(r => r.json()).catch(() => ({ conectado: false })),
    ]).then(([me, status]) => {
      setUserId(me.userId ?? null);
      setMlConectado(!!status.conectado);
      if (me.userId) carregar(me.userId);
    });
  }, []);

  function toggleSelect(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleSelectGrupo(ids: string[]) {
    setSelectedIds(prev => {
      const n = new Set(prev);
      const todosJa = ids.every(id => n.has(id));
      ids.forEach(id => todosJa ? n.delete(id) : n.add(id));
      return n;
    });
  }

  function selecionarTodos() {
    setSelectedIds(new Set(anunciosFiltrados.map(a => a.id)));
  }

  async function deletarSelecionados() {
    if (!selectedIds.size) return;
    setDeletandoSelecionados(true);
    const ids = [...selectedIds];
    await supabase.from("anuncios").update({ ativo: false }).in("id", ids);
    setAnuncios(prev => prev.filter(a => !selectedIds.has(a.id)));
    setSelectedIds(new Set());
    setModoSelecao(false);
    setDeletandoSelecionados(false);
  }

  async function importarDoML() {
    setImportando(true);
    setMsgImport(null);
    try {
      const res  = await fetch("/api/ml/importar-anuncios", { method: "POST" });
      const data = await res.json();
      if (data.erro) {
        setMsgImport({ ok: false, texto: data.mensagem ?? "Erro ao importar." });
      } else {
        setMsgImport({
          ok: true,
          texto: `✅ ${data.importados} importados, ${data.atualizados} atualizados${data.erros > 0 ? `, ${data.erros} erros` : ""} — total ${data.total} anúncios no ML`,
        });
        await carregar();
      }
    } catch {
      setMsgImport({ ok: false, texto: "Falha na conexão." });
    }
    setImportando(false);
  }

  async function sincronizarPrecos() {
    setSincronizando(true);
    setMsgSync(null);
    try {
      const res  = await fetch("/api/ml/sync-precos", { method: "POST" });
      const data = await res.json();
      setMsgSync({ ok: !data.erro, texto: data.mensagem, detalhes: data.detalhes ?? [] });
      if (!data.erro && data.atualizados > 0) await carregar();
    } catch {
      setMsgSync({ ok: false, texto: "Erro ao sincronizar com o Mercado Livre." });
    }
    setSincronizando(false);
  }

  async function atualizarSkus() {
    setAtualizandoSkus(true);
    setMsgSkus(null);
    try {
      const res  = await fetch("/api/ml/sync-skus", { method: "POST" });
      const data = await res.json();
      setMsgSkus({ ok: !data.erro, texto: data.mensagem });
      if (!data.erro && data.atualizados > 0) await carregar();
    } catch {
      setMsgSkus({ ok: false, texto: "Erro ao atualizar SKUs." });
    }
    setAtualizandoSkus(false);
  }

  async function excluir(id: string) {
    await supabase.from("anuncios").update({ ativo: false }).eq("id", id);
    setAnuncios(prev => prev.filter(a => a.id !== id));
  }

  async function excluirTodosDuplicados() {
    if (!idsAntigosDuplicados.size) return;
    setDeletandoDuplicados(true);
    const ids = [...idsAntigosDuplicados];
    await supabase.from("anuncios").update({ ativo: false }).in("id", ids);
    setAnuncios(prev => prev.filter(a => !idsAntigosDuplicados.has(a.id)));
    setFiltroDuplicados(false);
    setDeletandoDuplicados(false);
  }

  function abrirEditar(a: Anuncio) {
    setEditando(a);
    setShowForm(true);
  }

  // ── IDs dos duplicados antigos ───────────────────────────────────────────
  const idsAntigosDuplicados = useMemo(() => {
    const grupos = new Map<string, Anuncio[]>();
    anuncios.forEach(a => {
      if (a.ml_item_id) {
        const g = grupos.get(a.ml_item_id) ?? [];
        g.push(a);
        grupos.set(a.ml_item_id, g);
      }
    });
    const ids = new Set<string>();
    grupos.forEach(grupo => {
      if (grupo.length <= 1) return;
      // Grupos onde todos têm variation_id são variações intencionais — não duplicados
      if (grupo.every(a => a.variation_id)) return;
      grupo.slice(1).forEach(a => ids.add(a.id));
    });
    return ids;
  }, [anuncios]);

  // ── Lista filtrada ───────────────────────────────────────────────────────
  const anunciosFiltrados = useMemo(() => {
    let base = anuncios;
    if (busca === "__sem_sku__") {
      base = base.filter(a => !a.sku || a.sku.trim() === "");
    } else if (busca === "__frete_gratis__") {
      base = base.filter(a => (a as any).frete_gratis === true);
    } else if (busca.trim()) {
      const q = busca.toLowerCase();
      base = base.filter(a =>
        a.nome?.toLowerCase().includes(q) ||
        a.sku?.toLowerCase().includes(q) ||
        a.ml_item_id?.toLowerCase().includes(q)
      );
    }
    if (filtroMarketplace !== "todos") base = base.filter(a => a.marketplace === filtroMarketplace);
    if (filtroDuplicados) base = base.filter(a => idsAntigosDuplicados.has(a.id));
    if (filtroVariacao)   base = base.filter(a => !!a.variation_id);
    if (filtroLogistic === "full")   base = base.filter(a => (a as any).logistic_type === "fulfillment");
    if (filtroLogistic === "coleta") base = base.filter(a => !(a as any).logistic_type || (a as any).logistic_type === "me2" || (a as any).logistic_type === "cross_docking");
    return base;
  }, [anuncios, busca, filtroDuplicados, filtroMarketplace, idsAntigosDuplicados, filtroVariacao, filtroLogistic]);

  // ── Agrupar variações ────────────────────────────────────────────────────
  const { soloAnuncios, gruposVariacoes } = useMemo(() => {
    const mlIdMap = new Map<string, Anuncio[]>();
    const soloList: Anuncio[] = [];
    for (const a of anunciosFiltrados) {
      if (a.variation_id && a.ml_item_id) {
        const g = mlIdMap.get(a.ml_item_id) ?? [];
        g.push(a);
        mlIdMap.set(a.ml_item_id, g);
      } else {
        soloList.push(a);
      }
    }
    return {
      soloAnuncios:   soloList,
      gruposVariacoes: [...mlIdMap.values()],
    };
  }, [anunciosFiltrados]);

  // ── Indicador de filtros ativos ──────────────────────────────────────────
  const filtrosAtivos = (busca ? 1 : 0) + (filtroDuplicados ? 1 : 0) + (filtroMarketplace !== "todos" ? 1 : 0) + (filtroVariacao ? 1 : 0) + (filtroLogistic ? 1 : 0);

  const totalAnuncios   = anuncios.length;
  const mediaPrecoIdeal = totalAnuncios > 0
    ? anuncios.reduce((s, a) => s + (a.preco_ideal ?? 0), 0) / totalAnuncios
    : 0;

  return (
    <div style={{ padding: "32px" }}>

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "28px", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
            <h1 style={{ margin: 0, fontSize: "28px", fontWeight: 900 }}>Meus Anúncios</h1>
            {totalAnuncios > 0 && (
              <span style={{ background: "rgba(255,107,0,0.15)", color: "#ff6b00", fontWeight: 800, fontSize: "13px", borderRadius: "20px", padding: "3px 12px" }}>
                {totalAnuncios}
              </span>
            )}
          </div>
          {totalAnuncios > 0 && (
            <p style={{ margin: 0, color: "#9099aa", fontSize: "14px" }}>
              Preço ideal médio:{" "}
              <span style={{ color: "#00D97E", fontWeight: 700 }}>{moeda(mediaPrecoIdeal)}</span>
            </p>
          )}
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {/* Botão Filtro */}
          <button
            onClick={() => setPainelFiltros(v => !v)}
            style={{
              padding: "12px 20px",
              background: painelFiltros || filtrosAtivos > 0 ? "rgba(100,160,255,0.15)" : "rgba(255,255,255,0.05)",
              border: `1px solid ${painelFiltros || filtrosAtivos > 0 ? "rgba(100,160,255,0.4)" : "rgba(255,255,255,0.1)"}`,
              borderRadius: "14px",
              color: painelFiltros || filtrosAtivos > 0 ? "#6fa3ff" : "#d7dbe5",
              fontWeight: 800, fontSize: "14px",
              cursor: "pointer",
              display: "flex", alignItems: "center", gap: "8px",
            }}
          >
            <span style={{ fontSize: "15px" }}>⚙️</span>
            Filtro
            {filtrosAtivos > 0 && (
              <span style={{
                background: "#6fa3ff", color: "#10131b",
                fontSize: "11px", fontWeight: 900,
                borderRadius: "10px", padding: "1px 7px", lineHeight: "16px",
              }}>
                {filtrosAtivos}
              </span>
            )}
          </button>

          {/* Botão Selecionar */}
          {anuncios.length > 0 && (
            <button
              onClick={() => { setModoSelecao(v => !v); setSelectedIds(new Set()); }}
              style={{
                padding: "12px 20px",
                background: modoSelecao ? "rgba(255,77,77,0.12)" : "rgba(255,255,255,0.05)",
                border: `1px solid ${modoSelecao ? "rgba(255,77,77,0.35)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "14px",
                color: modoSelecao ? "#ff4d4d" : "#d7dbe5",
                fontWeight: 800, fontSize: "14px",
                cursor: "pointer",
                display: "flex", alignItems: "center", gap: "8px",
                transition: "all 0.15s",
              }}
            >
              {modoSelecao ? "✕ Cancelar" : "☑ Selecionar"}
            </button>
          )}

          {/* Botão Sincronizar */}
          <button
            onClick={sincronizarPrecos}
            disabled={sincronizando || !mlConectado}
            title={!mlConectado ? "Conecte o Mercado Livre primeiro" : "Sincronizar preços e dados com o ML"}
            style={{
              padding: "12px 20px",
              background: sincronizando ? "rgba(0,217,126,0.12)" : mlConectado ? "rgba(0,217,126,0.08)" : "rgba(255,255,255,0.04)",
              border: `1px solid ${sincronizando ? "rgba(0,217,126,0.4)" : mlConectado ? "rgba(0,217,126,0.25)" : "rgba(255,255,255,0.1)"}`,
              borderRadius: "14px",
              color: sincronizando ? "#00D97E" : mlConectado ? "#00D97E" : "#9099aa",
              fontWeight: 800, fontSize: "14px",
              cursor: sincronizando || !mlConectado ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", gap: "8px",
              opacity: !mlConectado ? 0.5 : 1,
              transition: "all 0.15s",
            }}
          >
            <span style={{
              fontSize: "15px",
              display: "inline-block",
              animation: sincronizando ? "spin 1s linear infinite" : "none",
            }}>🔄</span>
            {sincronizando ? "Sincronizando..." : "Sincronizar"}
          </button>

          {/* Botão Importar do ML */}
          {mlConectado && (
            <button
              onClick={importarDoML}
              disabled={importando}
              title="Importa todos os anúncios ativos do ML automaticamente"
              style={{
                padding: "12px 20px",
                background: importando ? "rgba(255,230,0,0.12)" : "rgba(255,230,0,0.08)",
                border: `1px solid ${importando ? "rgba(255,230,0,0.4)" : "rgba(255,230,0,0.25)"}`,
                borderRadius: "14px",
                color: "#FFE600",
                fontWeight: 800, fontSize: "14px",
                cursor: importando ? "not-allowed" : "pointer",
                display: "flex", alignItems: "center", gap: "8px",
                transition: "all 0.15s",
              }}
            >
              <span style={{
                fontSize: "15px",
                display: "inline-block",
                animation: importando ? "spin 1s linear infinite" : "none",
              }}>📥</span>
              {importando ? "Importando..." : "Importar do ML"}
            </button>
          )}

          <button
            onClick={() => { setEditando(null); setShowForm(true); }}
            style={{
              padding: "12px 22px",
              background: "linear-gradient(135deg,#ff6b00,#ffb800)",
              border: "none", borderRadius: "14px",
              fontWeight: 900, fontSize: "14px", color: "#10131b",
              cursor: "pointer", display: "flex", alignItems: "center", gap: "6px",
            }}
          >
            + Novo Anúncio
          </button>
        </div>
      </div>

      {/* ── Painel de Filtros ──────────────────────────────────── */}
      {painelFiltros && (
        <div style={{
          background: "#111318",
          border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: "18px",
          padding: "20px",
          marginBottom: "20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}>

          {/* Marketplace */}
          <div>
            <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px", display: "block", marginBottom: "7px" }}>
              MARKETPLACE
            </label>
            <div style={{ display: "flex", gap: "8px" }}>
              {([
                { key: "todos",  label: "Todos",           cor: "#d7dbe5", bg: "rgba(255,255,255,0.08)", border: "rgba(255,255,255,0.2)"  },
                { key: "ML",     label: "Mercado Livre",   cor: "#FFE600", bg: "rgba(255,230,0,0.12)",  border: "#FFE600"                 },
                { key: "Shopee", label: "Shopee",          cor: "#EE4D2D", bg: "rgba(238,77,45,0.12)",  border: "#EE4D2D"                 },
              ] as const).map(({ key, label, cor, bg, border }) => {
                const ativo = filtroMarketplace === key;
                const count = key === "todos"
                  ? anuncios.length
                  : anuncios.filter(a => a.marketplace === key).length;
                return (
                  <button
                    key={key}
                    onClick={() => setFiltroMarketplace(key)}
                    style={{
                      padding: "9px 16px",
                      background: ativo ? bg : "rgba(255,255,255,0.03)",
                      border: `1px solid ${ativo ? border : "rgba(255,255,255,0.1)"}`,
                      borderRadius: "11px",
                      color: ativo ? cor : "#9099aa",
                      fontWeight: ativo ? 800 : 600,
                      fontSize: "13px",
                      cursor: "pointer",
                      display: "flex", alignItems: "center", gap: "7px",
                      transition: "all 0.15s",
                    }}
                  >
                    {key === "ML"     && <span style={{ fontSize: "14px" }}>🛒</span>}
                    {key === "Shopee" && <span style={{ fontSize: "14px" }}>🟠</span>}
                    {label}
                    {count > 0 && (
                      <span style={{
                        background: ativo ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.07)",
                        color: ativo ? cor : "#9099aa",
                        fontSize: "11px", fontWeight: 800,
                        borderRadius: "8px", padding: "1px 6px",
                      }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Busca */}
          <div>
            <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px", display: "block", marginBottom: "7px" }}>
              BUSCAR
            </label>
            <div style={{ position: "relative" }}>
              <span style={{ position: "absolute", left: "13px", top: "50%", transform: "translateY(-50%)", fontSize: "15px", pointerEvents: "none" }}>🔍</span>
              <input
                type="text"
                placeholder="Nome, SKU ou código ML..."
                value={busca}
                onChange={e => setBusca(e.target.value)}
                style={{
                  width: "100%",
                  padding: "10px 36px 10px 38px",
                  borderRadius: "12px",
                  border: "1px solid rgba(255,255,255,0.1)",
                  background: "rgba(255,255,255,0.05)",
                  color: "white",
                  fontSize: "14px",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              {busca && (
                <button
                  onClick={() => setBusca("")}
                  style={{ position: "absolute", right: "11px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#9099aa", cursor: "pointer", fontSize: "18px", lineHeight: 1 }}
                >×</button>
              )}
            </div>
          </div>

          {/* Linha de filtros rápidos */}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px", alignSelf: "center" }}>
              FILTROS RÁPIDOS
            </label>

            {/* Duplicados */}
            <button
              onClick={() => setFiltroDuplicados(v => !v)}
              style={{
                padding: "8px 14px",
                background: filtroDuplicados ? "rgba(255,60,60,0.18)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${filtroDuplicados ? "rgba(255,60,60,0.45)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "10px",
                color: filtroDuplicados ? "#ff6060" : "#9099aa",
                fontWeight: 700, fontSize: "13px",
                cursor: "pointer",
                display: "flex", alignItems: "center", gap: "6px",
              }}
            >
              🔁 Duplicados
              {idsAntigosDuplicados.size > 0 && (
                <span style={{
                  background: filtroDuplicados ? "rgba(255,60,60,0.35)" : "rgba(255,255,255,0.08)",
                  color: filtroDuplicados ? "#ff6060" : "#9099aa",
                  fontSize: "11px", fontWeight: 800,
                  borderRadius: "8px", padding: "1px 6px",
                }}>
                  {idsAntigosDuplicados.size}
                </span>
              )}
            </button>

            {/* Sem SKU */}
            <button
              onClick={() => setBusca(prev => prev === "__sem_sku__" ? "" : "__sem_sku__")}
              style={{
                padding: "8px 14px",
                background: busca === "__sem_sku__" ? "rgba(255,180,0,0.15)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${busca === "__sem_sku__" ? "rgba(255,180,0,0.4)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "10px",
                color: busca === "__sem_sku__" ? "#ffb800" : "#9099aa",
                fontWeight: 700, fontSize: "13px",
                cursor: "pointer",
              }}
            >
              🏷️ Sem SKU
            </button>

            {/* Frete grátis */}
            <button
              onClick={() => setBusca(prev => prev === "__frete_gratis__" ? "" : "__frete_gratis__")}
              style={{
                padding: "8px 14px",
                background: busca === "__frete_gratis__" ? "rgba(0,217,126,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${busca === "__frete_gratis__" ? "rgba(0,217,126,0.35)" : "rgba(255,255,255,0.1)"}`,
                borderRadius: "10px",
                color: busca === "__frete_gratis__" ? "#00D97E" : "#9099aa",
                fontWeight: 700, fontSize: "13px",
                cursor: "pointer",
              }}
            >
              🚚 Frete Grátis
            </button>

            {/* Variação */}
            {(() => {
              const count = anuncios.filter(a => !!a.variation_id).length;
              return count > 0 ? (
                <button
                  onClick={() => setFiltroVariacao(v => !v)}
                  style={{
                    padding: "8px 14px",
                    background: filtroVariacao ? "rgba(192,132,252,0.15)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${filtroVariacao ? "rgba(192,132,252,0.45)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: "10px",
                    color: filtroVariacao ? "#c084fc" : "#9099aa",
                    fontWeight: 700, fontSize: "13px",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: "6px",
                  }}
                >
                  🔀 Variação
                  <span style={{ background: filtroVariacao ? "rgba(192,132,252,0.3)" : "rgba(255,255,255,0.08)", color: filtroVariacao ? "#c084fc" : "#9099aa", fontSize: "11px", fontWeight: 800, borderRadius: "8px", padding: "1px 6px" }}>
                    {count}
                  </span>
                </button>
              ) : null;
            })()}

            {/* Full */}
            {(() => {
              const count = anuncios.filter(a => (a as any).logistic_type === "fulfillment").length;
              return count > 0 ? (
                <button
                  onClick={() => setFiltroLogistic(prev => prev === "full" ? "" : "full")}
                  style={{
                    padding: "8px 14px",
                    background: filtroLogistic === "full" ? "rgba(56,189,248,0.15)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${filtroLogistic === "full" ? "rgba(56,189,248,0.45)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: "10px",
                    color: filtroLogistic === "full" ? "#38bdf8" : "#9099aa",
                    fontWeight: 700, fontSize: "13px",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: "6px",
                  }}
                >
                  🏭 Full
                  <span style={{ background: filtroLogistic === "full" ? "rgba(56,189,248,0.3)" : "rgba(255,255,255,0.08)", color: filtroLogistic === "full" ? "#38bdf8" : "#9099aa", fontSize: "11px", fontWeight: 800, borderRadius: "8px", padding: "1px 6px" }}>
                    {count}
                  </span>
                </button>
              ) : null;
            })()}

            {/* Coleta / ME2 */}
            {(() => {
              const count = anuncios.filter(a => !(a as any).logistic_type || (a as any).logistic_type === "me2" || (a as any).logistic_type === "cross_docking").length;
              return count > 0 ? (
                <button
                  onClick={() => setFiltroLogistic(prev => prev === "coleta" ? "" : "coleta")}
                  style={{
                    padding: "8px 14px",
                    background: filtroLogistic === "coleta" ? "rgba(255,183,77,0.15)" : "rgba(255,255,255,0.04)",
                    border: `1px solid ${filtroLogistic === "coleta" ? "rgba(255,183,77,0.45)" : "rgba(255,255,255,0.1)"}`,
                    borderRadius: "10px",
                    color: filtroLogistic === "coleta" ? "#ffb74d" : "#9099aa",
                    fontWeight: 700, fontSize: "13px",
                    cursor: "pointer",
                    display: "flex", alignItems: "center", gap: "6px",
                  }}
                >
                  📦 Coleta
                  <span style={{ background: filtroLogistic === "coleta" ? "rgba(255,183,77,0.3)" : "rgba(255,255,255,0.08)", color: filtroLogistic === "coleta" ? "#ffb74d" : "#9099aa", fontSize: "11px", fontWeight: 800, borderRadius: "8px", padding: "1px 6px" }}>
                    {count}
                  </span>
                </button>
              ) : null;
            })()}

            {/* Limpar todos */}
            {filtrosAtivos > 0 && (
              <button
                onClick={() => { setBusca(""); setFiltroDuplicados(false); setFiltroMarketplace("todos"); setFiltroVariacao(false); setFiltroLogistic(""); }}
                style={{
                  padding: "8px 14px",
                  background: "none",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: "10px",
                  color: "#9099aa", fontWeight: 700, fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                Limpar filtros
              </button>
            )}
          </div>

          {/* Separador */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: "14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
            <span style={{ fontSize: "11px", color: "#9099aa" }}>
              Ações de manutenção
            </span>
            <button
              onClick={atualizarSkus}
              disabled={atualizandoSkus || !mlConectado}
              title={!mlConectado ? "Conecte o Mercado Livre primeiro" : "Buscar SKU automaticamente para anúncios sem SKU"}
              style={{
                padding: "9px 16px",
                background: mlConectado ? "rgba(100,160,255,0.08)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${mlConectado ? "rgba(100,160,255,0.2)" : "rgba(255,255,255,0.07)"}`,
                borderRadius: "10px",
                color: mlConectado ? "#6fa3ff" : "#9099aa",
                fontWeight: 700, fontSize: "12px",
                cursor: mlConectado && !atualizandoSkus ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", gap: "6px",
                opacity: atualizandoSkus ? 0.7 : 1,
              }}
            >
              {atualizandoSkus ? "⏳ Atualizando..." : "🏷️ Atualizar SKUs via ML"}
            </button>
          </div>

          {/* Feedback SKUs */}
          {msgSkus && (
            <div style={{
              background: msgSkus.ok ? "rgba(0,217,126,0.06)" : "rgba(255,60,60,0.07)",
              border: `1px solid ${msgSkus.ok ? "rgba(0,217,126,0.18)" : "rgba(255,60,60,0.18)"}`,
              borderRadius: "10px", padding: "10px 14px",
              color: msgSkus.ok ? "#00D97E" : "#ff4d4d", fontSize: "13px",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px",
            }}>
              <span>{msgSkus.ok ? "🏷️" : "⚠️"} {msgSkus.texto}</span>
              <button onClick={() => setMsgSkus(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: "16px", opacity: 0.6 }}>×</button>
            </div>
          )}
        </div>
      )}

      {/* ── Feedback Sincronização ─────────────────────────────── */}
      {msgSync && (
        <div style={{
          background: msgSync.ok ? "rgba(0,217,126,0.06)" : "rgba(255,60,60,0.07)",
          border: `1px solid ${msgSync.ok ? "rgba(0,217,126,0.2)" : "rgba(255,60,60,0.2)"}`,
          borderRadius: "14px", padding: "14px 18px",
          marginBottom: "16px",
          display: "flex", flexDirection: "column", gap: "8px",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
            <span style={{ color: msgSync.ok ? "#00D97E" : "#ff4d4d", fontWeight: 800, fontSize: "14px" }}>
              {msgSync.ok ? "✅" : "⚠️"} {msgSync.texto}
            </span>
            <button onClick={() => setMsgSync(null)} style={{ background: "none", border: "none", color: "#9099aa", cursor: "pointer", fontSize: "18px", opacity: 0.6 }}>×</button>
          </div>
          {msgSync.detalhes && msgSync.detalhes.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px", paddingTop: "6px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
              {msgSync.detalhes.map((d, i) => (
                <div key={i} style={{ fontSize: "12px", color: "#ffb800", fontFamily: "monospace" }}>
                  💰 {d}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Feedback Importar do ML ───────────────────────────── */}
      {msgImport && (
        <div style={{
          background: msgImport.ok ? "rgba(255,230,0,0.06)" : "rgba(255,60,60,0.07)",
          border: `1px solid ${msgImport.ok ? "rgba(255,230,0,0.2)" : "rgba(255,60,60,0.2)"}`,
          borderRadius: "14px", padding: "14px 18px",
          marginBottom: "16px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px",
        }}>
          <span style={{ color: msgImport.ok ? "#FFE600" : "#ff4d4d", fontWeight: 800, fontSize: "14px" }}>
            {msgImport.texto}
          </span>
          <button onClick={() => setMsgImport(null)} style={{ background: "none", border: "none", color: "#9099aa", cursor: "pointer", fontSize: "18px", opacity: 0.6 }}>×</button>
        </div>
      )}

      {/* ── Banner duplicados (quando filtro ativo) ────────────── */}
      {filtroDuplicados && idsAntigosDuplicados.size > 0 && (
        <div style={{
          background: "rgba(255,60,60,0.06)",
          border: "1px solid rgba(255,60,60,0.2)",
          borderRadius: "14px",
          padding: "12px 16px",
          marginBottom: "20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span style={{ fontSize: "18px" }}>🔁</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: "13px", color: "#ff6060" }}>
                {idsAntigosDuplicados.size} produto{idsAntigosDuplicados.size !== 1 ? "s" : ""} duplicado{idsAntigosDuplicados.size !== 1 ? "s" : ""} (mais antigos)
              </div>
              <div style={{ color: "#9099aa", fontSize: "12px" }}>
                O mais recente de cada grupo está preservado. Delete os abaixo com segurança.
              </div>
            </div>
          </div>
          <button
            onClick={excluirTodosDuplicados}
            disabled={deletandoDuplicados}
            style={{
              padding: "9px 16px",
              background: "rgba(255,60,60,0.15)",
              border: "1px solid rgba(255,60,60,0.35)",
              borderRadius: "10px",
              color: "#ff6060",
              fontWeight: 800, fontSize: "12px",
              cursor: deletandoDuplicados ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              opacity: deletandoDuplicados ? 0.6 : 1,
            }}
          >
            {deletandoDuplicados ? "⏳ Deletando..." : `🗑️ Deletar todos (${idsAntigosDuplicados.size})`}
          </button>
        </div>
      )}

      {/* ── Aviso ML desconectado ──────────────────────────────── */}
      {!mlConectado && (
        <div style={{
          background: "rgba(255,180,0,0.06)", border: "1px solid rgba(255,180,0,0.18)",
          borderRadius: "16px", padding: "14px 18px", marginBottom: "24px",
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "20px" }}>⚡</span>
            <div>
              <div style={{ fontWeight: 800, fontSize: "14px", color: "#ffb800" }}>Mercado Livre não conectado</div>
              <div style={{ color: "#9099aa", fontSize: "13px" }}>Conecte para buscar anúncios pelo link automaticamente.</div>
            </div>
          </div>
          <a href="/api/auth/mercadolivre" style={{
            padding: "10px 18px", textDecoration: "none",
            background: "#FFE600", borderRadius: "12px",
            fontWeight: 900, color: "#10131b", fontSize: "13px", whiteSpace: "nowrap",
          }}>
            Conectar ML
          </a>
        </div>
      )}

      {/* ── Modal ──────────────────────────────────────────────── */}
      {showForm && (
        <FormAnuncio
          inicial={editando}
          userId={userId}
          onSalvar={() => { setShowForm(false); carregar(); }}
          onFechar={() => setShowForm(false)}
        />
      )}

      {/* ── Grid de anúncios ───────────────────────────────────── */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "60px", color: "#9099aa" }}>Carregando...</div>
      ) : anuncios.length === 0 ? (
        <div style={{ textAlign: "center", padding: "80px 20px", border: "2px dashed rgba(255,255,255,0.08)", borderRadius: "24px", color: "#9099aa" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>📦</div>
          <p style={{ fontSize: "18px", fontWeight: 700, color: "#d7dbe5", margin: "0 0 8px" }}>Nenhum anúncio cadastrado ainda</p>
          <p style={{ margin: 0 }}>Clique em "+ Novo Anúncio" e cole o link do seu produto no ML</p>
        </div>
      ) : anunciosFiltrados.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", border: "2px dashed rgba(255,255,255,0.08)", borderRadius: "24px", color: "#9099aa" }}>
          {filtroDuplicados ? (
            <>
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>✅</div>
              <p style={{ fontSize: "16px", fontWeight: 700, color: "#d7dbe5", margin: "0 0 6px" }}>Nenhum produto duplicado</p>
              <p style={{ margin: 0, fontSize: "13px" }}>Todos os seus anuncios sao unicos.</p>
            </>
          ) : (
            <>
              <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔍</div>
              <p style={{ fontSize: "16px", fontWeight: 700, color: "#d7dbe5", margin: "0 0 6px" }}>Nenhum anuncio encontrado</p>
              <p style={{ margin: 0, fontSize: "13px" }}>Tente ajustar os filtros.</p>
            </>
          )}
        </div>
      ) : (
        <>
        {/* ── Barra selecionar todos (modo seleção ativo) ──────── */}
        {modoSelecao && (
          <div style={{
            display: "flex", alignItems: "center", gap: "12px",
            background: "#111318", border: "1px solid rgba(255,255,255,0.09)",
            borderRadius: "12px", padding: "10px 16px", marginBottom: "14px",
          }}>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={anunciosFiltrados.length > 0 && anunciosFiltrados.every(a => selectedIds.has(a.id))}
                onChange={e => e.target.checked ? selecionarTodos() : setSelectedIds(new Set())}
                style={{ width: 16, height: 16, accentColor: "#ff4d4d", cursor: "pointer" }}
              />
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#d7dbe5" }}>
                Selecionar todos ({anunciosFiltrados.length})
              </span>
            </label>
            {selectedIds.size > 0 && (
              <span style={{ fontSize: "12px", color: "#9099aa" }}>
                {selectedIds.size} selecionado{selectedIds.size !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "18px" }}>
          {/* Grupos de variacoes — renderiza 1 card por grupo */}
          {gruposVariacoes.map(grupo => {
            const grupoIds = grupo.map(v => v.id);
            const todosSelected = grupoIds.every(id => selectedIds.has(id));
            return (
              <div key={grupo[0].ml_item_id} style={{ position: "relative" }}>
                {modoSelecao && (
                  <div
                    onClick={() => toggleSelectGrupo(grupoIds)}
                    style={{
                      position: "absolute", top: 14, left: 14, zIndex: 10,
                      width: 20, height: 20, borderRadius: 5,
                      background: todosSelected ? "#ff4d4d" : "rgba(30,33,45,0.92)",
                      border: `2px solid ${todosSelected ? "#ff4d4d" : "rgba(255,255,255,0.25)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", transition: "all 0.12s",
                    }}
                  >
                    {todosSelected && <span style={{ color: "#fff", fontSize: 12, fontWeight: 900 }}>✓</span>}
                  </div>
                )}
                <div style={{ opacity: modoSelecao && !todosSelected ? 0.75 : 1, transition: "opacity 0.12s" }}>
                  <CardAnuncioVariacoes
                    variacoes={grupo}
                    onEditar={abrirEditar}
                    onExcluir={excluir}
                  />
                </div>
              </div>
            );
          })}
          {/* Anuncios sem variacao — card normal */}
          {soloAnuncios.map(a => {
            const sel = selectedIds.has(a.id);
            return (
              <div key={a.id} style={{ position: "relative" }}>
                {modoSelecao && (
                  <div
                    onClick={() => toggleSelect(a.id)}
                    style={{
                      position: "absolute", top: 14, left: 14, zIndex: 10,
                      width: 20, height: 20, borderRadius: 5,
                      background: sel ? "#ff4d4d" : "rgba(30,33,45,0.92)",
                      border: `2px solid ${sel ? "#ff4d4d" : "rgba(255,255,255,0.25)"}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", transition: "all 0.12s",
                    }}
                  >
                    {sel && <span style={{ color: "#fff", fontSize: 12, fontWeight: 900 }}>✓</span>}
                  </div>
                )}
                <div style={{ opacity: modoSelecao && !sel ? 0.75 : 1, transition: "opacity 0.12s" }}>
                  <CardAnuncio
                    anuncio={a}
                    onEditar={() => abrirEditar(a)}
                    onExcluir={() => excluir(a.id)}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Barra flutuante de exclusão ──────────────────────── */}
        {modoSelecao && selectedIds.size > 0 && (
          <div style={{
            position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
            zIndex: 200,
            background: "#1a1d27",
            border: "1px solid rgba(255,77,77,0.35)",
            borderRadius: "20px",
            padding: "14px 24px",
            display: "flex", alignItems: "center", gap: "20px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            minWidth: "320px",
          }}>
            <span style={{ fontSize: "14px", fontWeight: 700, color: "#d7dbe5" }}>
              🗑️ {selectedIds.size} anúncio{selectedIds.size !== 1 ? "s" : ""} selecionado{selectedIds.size !== 1 ? "s" : ""}
            </span>
            <div style={{ display: "flex", gap: "10px", marginLeft: "auto" }}>
              <button
                onClick={() => setSelectedIds(new Set())}
                style={{
                  padding: "8px 16px", borderRadius: "10px",
                  background: "transparent", border: "1px solid rgba(255,255,255,0.12)",
                  color: "#9099aa", fontWeight: 700, fontSize: "13px", cursor: "pointer",
                }}
              >
                Limpar
              </button>
              <button
                onClick={deletarSelecionados}
                disabled={deletandoSelecionados}
                style={{
                  padding: "8px 20px", borderRadius: "10px",
                  background: deletandoSelecionados ? "rgba(255,77,77,0.2)" : "#ff4d4d",
                  border: "none",
                  color: deletandoSelecionados ? "#ff4d4d" : "#fff",
                  fontWeight: 900, fontSize: "13px",
                  cursor: deletandoSelecionados ? "not-allowed" : "pointer",
                  transition: "all 0.15s",
                }}
              >
                {deletandoSelecionados ? "Deletando..." : `Deletar ${selectedIds.size}`}
              </button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
