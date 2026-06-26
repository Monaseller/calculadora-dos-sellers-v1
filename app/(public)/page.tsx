import Link from "next/link";

export default function LandingPage() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "radial-gradient(circle at 75% 0%, rgba(255,122,0,0.14) 0%, transparent 45%), #08090e",
      color: "#fff",
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,sans-serif",
      overflowX: "hidden",
    }}>

      {/* ── HEADER ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 56px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <div style={{
            background: "linear-gradient(135deg, #ff7a00, #ffb000)",
            borderRadius: "12px", padding: "7px 14px",
            fontWeight: 900, fontSize: "22px", color: "#000", letterSpacing: "-0.5px",
            display: "flex", alignItems: "center", gap: "6px",
          }}>
            <span>🧮</span> CDS
          </div>
          <div style={{ fontSize: "8px", fontWeight: 700, color: "#555", letterSpacing: "1.5px", marginTop: "5px" }}>
            CALCULADORA DOS SELLERS
          </div>
        </div>

        {/* Nav */}
        <nav style={{ display: "flex", gap: "34px" }}>
          {[
            { label: "Inicio", active: true },
            { label: "Recursos" }, { label: "Como funciona" },
            { label: "Planos" }, { label: "Depoimentos" }, { label: "FAQ" },
          ].map(({ label, active }) => (
            <a key={label} href="#" style={{
              color: active ? "#ff7a00" : "#d1d5db",
              fontWeight: 600, fontSize: "14px", textDecoration: "none",
              borderBottom: active ? "2px solid #ff7a00" : "2px solid transparent",
              paddingBottom: "3px",
            }}>{label}</a>
          ))}
        </nav>

        {/* Buttons */}
        <div style={{ display: "flex", gap: "10px" }}>
          <Link href="/login" style={{
            padding: "10px 22px", borderRadius: "9px",
            border: "1px solid rgba(255,255,255,0.18)",
            color: "#fff", fontWeight: 700, fontSize: "14px", textDecoration: "none",
          }}>Entrar</Link>
          <Link href="/login" style={{
            padding: "10px 22px", borderRadius: "9px",
            background: "linear-gradient(135deg, #ff7a00, #ffb000)",
            color: "#fff", fontWeight: 700, fontSize: "14px", textDecoration: "none",
          }}>Testar grátis</Link>
        </div>
      </header>

      {/* ── HERO ── */}
      <section style={{
        display: "grid", gridTemplateColumns: "1fr 1.45fr",
        gap: "56px", padding: "56px 56px 40px",
        alignItems: "center",
      }}>
        {/* Left */}
        <div>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: "8px",
            border: "1px solid rgba(255,255,255,0.14)", borderRadius: "999px",
            padding: "8px 16px", fontSize: "13px", fontWeight: 600, color: "#d1d5db",
            marginBottom: "22px",
          }}>⭐ A Nº1 em precificação para Sellers</div>

          <h1 style={{ fontSize: "58px", fontWeight: 900, lineHeight: 1.08, margin: "0 0 20px", letterSpacing: "-1.5px" }}>
            Precifique com{" "}
            <span style={{ color: "#ff7a00" }}>inteligência.</span>
            <br />Venda com lucro<br />de verdade.
          </h1>

          <p style={{ fontSize: "17px", color: "#94a3b8", lineHeight: 1.7, margin: "0 0 30px", maxWidth: "460px" }}>
            A Calculadora dos Sellers te mostra exatamente quanto você vai lucrar
            em cada venda nos marketplaces. Chega de achismos. É{" "}
            <span style={{ color: "#ff7a00", fontWeight: 700 }}>números</span>,{" "}
            <span style={{ color: "#ff7a00", fontWeight: 700 }}>estratégia</span> e{" "}
            <span style={{ color: "#ff7a00", fontWeight: 700 }}>resultado</span>.
          </p>

          <div style={{ display: "flex", gap: "12px", marginBottom: "30px", flexWrap: "wrap" }}>
            <Link href="/login" style={{
              padding: "14px 26px", borderRadius: "10px",
              background: "linear-gradient(135deg, #ff7a00, #ffb000)",
              color: "#fff", fontWeight: 800, fontSize: "15px", textDecoration: "none",
              display: "inline-flex", alignItems: "center", gap: "8px",
            }}>⚡ Testar grátis por 1 dia</Link>
            <button style={{
              padding: "14px 24px", borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.18)", background: "transparent",
              color: "#fff", fontWeight: 700, fontSize: "15px", cursor: "pointer",
              display: "inline-flex", alignItems: "center", gap: "8px",
            }}>▶ Ver como funciona</button>
          </div>

          <div style={{ display: "flex", gap: "22px", flexWrap: "wrap" }}>
            {[
              ["🎯", "Cálculo automático em segundos"],
              ["🛡️", "Dados 100% seguros e confidenciais"],
              ["📈", "Mais lucro em cada venda"],
            ].map(([icon, text]) => (
              <div key={text} style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "13px", color: "#94a3b8" }}>
                <span>{icon}</span>{text}
              </div>
            ))}
          </div>
        </div>

        {/* Right — Dashboard card */}
        <div style={{ position: "relative" }}>
          <div style={{
            background: "#0d1117",
            border: "1px solid rgba(255,122,0,0.28)",
            borderRadius: "20px", overflow: "hidden",
            boxShadow: "0 0 70px rgba(255,122,0,0.10), 0 30px 70px rgba(0,0,0,0.55)",
            display: "flex",
          }}>

            {/* Sidebar */}
            <div style={{
              width: "155px", background: "#070a0f", flexShrink: 0,
              borderRight: "1px solid rgba(255,255,255,0.06)",
              display: "flex", flexDirection: "column",
            }}>
              <div style={{ padding: "14px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{
                  background: "linear-gradient(135deg, #ff7a00, #ffb000)",
                  borderRadius: "8px", padding: "5px 10px",
                  fontWeight: 900, fontSize: "13px", color: "#000",
                  display: "inline-flex", alignItems: "center", gap: "5px",
                }}>🧮 CDS</div>
              </div>

              {[
                { icon: "🧮", label: "Calculadora", active: true },
                { icon: "📋", label: "Histórico" },
                { icon: "📢", label: "Anúncios" },
                { icon: "📦", label: "Produtos" },
                { icon: "📊", label: "Análises" },
                { icon: "📈", label: "Anúncios Ads" },
                { icon: "⚙️", label: "Configurações" },
              ].map(({ icon, label, active }) => (
                <div key={label} style={{
                  display: "flex", alignItems: "center", gap: "9px",
                  padding: "9px 12px",
                  background: active ? "rgba(255,122,0,0.09)" : "transparent",
                  borderLeft: `3px solid ${active ? "#ff7a00" : "transparent"}`,
                }}>
                  <span style={{ fontSize: "13px" }}>{icon}</span>
                  <span style={{ fontSize: "11px", fontWeight: active ? 700 : 400, color: active ? "#ff7a00" : "#6b7280" }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>

            {/* Main content */}
            <div style={{ flex: 1, padding: "18px 18px 16px", minWidth: 0 }}>

              {/* Top row */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                <div style={{ fontWeight: 800, fontSize: "14px" }}>Resultado da precificação</div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <span style={{ fontSize: "10px", color: "#94a3b8" }}>Saúde da venda</span>
                  <span style={{
                    background: "rgba(34,197,94,0.13)", border: "1px solid rgba(34,197,94,0.28)",
                    color: "#22c55e", fontWeight: 800, fontSize: "9px",
                    padding: "3px 9px", borderRadius: "6px", letterSpacing: "0.5px",
                  }}>SAUDÁVEL</span>
                </div>
              </div>

              {/* 4 metrics */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "8px", marginBottom: "10px" }}>
                {[
                  { label: "Valor a receber", value: "R$ 84,85", green: true },
                  { label: "Lucro líquido", value: "R$ 24,18", green: true },
                  { label: "Margem de contribuição", value: "28,53%" },
                  { label: "Margem líquida", value: "20,68%", green: true },
                ].map(m => (
                  <div key={m.label} style={{
                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: "10px", padding: "10px 10px 8px",
                  }}>
                    <div style={{ fontSize: "9px", color: "#94a3b8", marginBottom: "5px", lineHeight: 1.3 }}>{m.label}</div>
                    <div style={{ fontSize: "16px", fontWeight: 800, color: m.green ? "#22c55e" : "#fff" }}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* 2 prices */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px", marginBottom: "12px" }}>
                {[
                  { label: "Preço original", value: "R$ 116,90", sub: "Margem: 28,53%" },
                  { label: "Preço promocional (+20%)", value: "R$ 140,28", sub: "Margem: 33,65%" },
                ].map(p => (
                  <div key={p.label} style={{
                    background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: "10px", padding: "12px",
                  }}>
                    <div style={{ fontSize: "9px", color: "#94a3b8", marginBottom: "4px" }}>{p.label}</div>
                    <div style={{ fontSize: "24px", fontWeight: 900 }}>{p.value}</div>
                    <div style={{ fontSize: "9px", color: "#94a3b8", marginTop: "3px" }}>{p.sub}</div>
                  </div>
                ))}
              </div>

              {/* Health bar */}
              <div style={{ marginBottom: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                  <span style={{ fontSize: "10px", color: "#94a3b8" }}>Saúde da venda</span>
                  <span style={{ fontSize: "10px", color: "#22c55e", fontWeight: 700 }}>Muito boa 😊</span>
                </div>
                <div style={{ height: "7px", background: "rgba(255,255,255,0.07)", borderRadius: "999px", overflow: "hidden" }}>
                  <div style={{ width: "75%", height: "100%", background: "linear-gradient(90deg,#22c55e,#facc15,#ff7a00)", borderRadius: "999px" }}/>
                </div>
              </div>

              {/* 2-col: costs + product */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                {/* Costs */}
                <div>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: "#94a3b8", marginBottom: "7px" }}>Resumo dos custos</div>
                  {[
                    ["Custo do produto", "R$44,85"],
                    ["Insumos", "R$1,50"],
                    ["Impostos", "R$8,45"],
                    ["Comissão do marketplace", "R$15,19"],
                    ["Frete", "R$16,85"],
                    ["Taxa fixa", "R$6,55"],
                  ].map(([k, v]) => (
                    <div key={k} style={{
                      display: "flex", justifyContent: "space-between",
                      fontSize: "10px", padding: "3px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                    }}>
                      <span style={{ color: "#94a3b8" }}>{k}</span>
                      <span style={{ color: "#fff", fontWeight: 600 }}>{v}</span>
                    </div>
                  ))}
                </div>

                {/* Product */}
                <div>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: "#94a3b8", marginBottom: "7px" }}>Dados do anúncio</div>
                  <div style={{
                    background: "rgba(255,255,255,0.04)", borderRadius: "10px",
                    padding: "10px", display: "flex", gap: "10px",
                  }}>
                    <div style={{
                      width: "52px", height: "52px", flexShrink: 0,
                      background: "#fff", borderRadius: "8px",
                      display: "grid", placeItems: "center", fontSize: "22px",
                    }}>📦</div>
                    <div>
                      <div style={{ fontSize: "10px", fontWeight: 700, color: "#fff", lineHeight: 1.4, marginBottom: "4px" }}>
                        Kit 3 Pinças Curva<br/>Reta Volume Fio a Fio
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "2px" }}>
                        <span style={{ width: "5px", height: "5px", borderRadius: "50%", background: "#22c55e", display: "inline-block" }}/>
                        <span style={{ fontSize: "9px", color: "#22c55e" }}>Mercado Livre · Clássico</span>
                      </div>
                      <div style={{ fontSize: "9px", color: "#94a3b8" }}>Categoria: Pinças</div>
                      <div style={{ fontSize: "9px", color: "#94a3b8", marginTop: "4px" }}>Preço no anúncio</div>
                      <div style={{ fontSize: "13px", fontWeight: 800, color: "#fff" }}>R$ 116,90</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Floating card */}
          <div style={{
            position: "absolute", right: "-20px", bottom: "60px",
            background: "linear-gradient(135deg, #ff7a00, #ff9d00)",
            borderRadius: "16px", padding: "16px 20px",
            boxShadow: "0 16px 40px rgba(255,122,0,0.45)",
          }}>
            <div style={{ fontSize: "28px", marginBottom: "8px" }}>📈</div>
            <div style={{ fontWeight: 900, fontSize: "13px", color: "#fff", lineHeight: 1.6 }}>
              + LUCRO<br/>+ ESTRATÉGIA<br/>+ RESULTADOS
            </div>
          </div>
        </div>
      </section>

      {/* ── VIDEO + FEATURES ── */}
      <section style={{
        display: "grid", gridTemplateColumns: "1fr 1.2fr",
        gap: "40px", margin: "20px 56px 24px",
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: "22px", padding: "36px",
      }}>

        {/* Video */}
        <div>
          <h2 style={{ fontSize: "26px", fontWeight: 800, margin: "0 0 10px" }}>
            Veja <span style={{ color: "#ff7a00" }}>como funciona</span> na prática
          </h2>
          <p style={{ color: "#94a3b8", fontSize: "14px", margin: "0 0 18px" }}>
            Assista ao vídeo e entenda como a CDS vai transformar seus resultados.
          </p>

          {/* Video player */}
          <div style={{
            background: "linear-gradient(135deg, #080a10, #111827)",
            border: "1px solid rgba(255,122,0,0.35)",
            borderRadius: "14px", overflow: "hidden",
          }}>
            {/* Video preview area */}
            <div style={{ height: "190px", position: "relative", display: "grid", placeItems: "center" }}>
              {/* Fake app screenshot bg */}
              <div style={{
                position: "absolute", inset: "8px", borderRadius: "8px",
                background: "rgba(255,255,255,0.03)",
                display: "flex", overflow: "hidden",
              }}>
                <div style={{ width: "70px", background: "rgba(0,0,0,0.4)", borderRight: "1px solid rgba(255,255,255,0.06)" }}/>
                <div style={{ flex: 1, padding: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ height: "10px", background: "rgba(255,255,255,0.08)", borderRadius: "3px", width: "55%" }}/>
                  <div style={{ height: "7px", background: "rgba(255,255,255,0.05)", borderRadius: "3px", width: "75%" }}/>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "5px", marginTop: "4px" }}>
                    {[1,2,3,4].map(i => (
                      <div key={i} style={{ height: "36px", background: "rgba(255,255,255,0.05)", borderRadius: "6px" }}/>
                    ))}
                  </div>
                </div>
              </div>
              {/* Play button */}
              <button style={{
                width: "58px", height: "58px", borderRadius: "50%",
                background: "linear-gradient(135deg, #ff7a00, #ffb000)",
                border: "none", color: "#fff", fontSize: "22px",
                cursor: "pointer", display: "grid", placeItems: "center",
                boxShadow: "0 8px 28px rgba(255,122,0,0.55)",
                position: "relative", zIndex: 1,
              }}>▶</button>
            </div>

            {/* Controls */}
            <div style={{
              padding: "9px 14px", background: "rgba(0,0,0,0.45)",
              display: "flex", alignItems: "center", gap: "10px",
            }}>
              <span style={{ fontSize: "13px", cursor: "pointer" }}>▶</span>
              <span style={{ fontSize: "10px", color: "#94a3b8", whiteSpace: "nowrap" }}>1:25 / 2:30</span>
              <div style={{ flex: 1, height: "3px", background: "rgba(255,255,255,0.12)", borderRadius: "2px", position: "relative" }}>
                <div style={{ width: "55%", height: "100%", background: "#ff7a00", borderRadius: "2px" }}/>
                <div style={{
                  position: "absolute", left: "55%", top: "50%",
                  transform: "translate(-50%,-50%)",
                  width: "9px", height: "9px", borderRadius: "50%", background: "#ff7a00",
                }}/>
              </div>
              <span style={{ fontSize: "13px", color: "#94a3b8" }}>🔊</span>
              <span style={{ fontSize: "13px", color: "#94a3b8" }}>⚙️</span>
              <span style={{ fontSize: "13px", color: "#94a3b8" }}>⛶</span>
            </div>
          </div>
        </div>

        {/* Features */}
        <div>
          <h2 style={{ fontSize: "24px", fontWeight: 800, margin: "0 0 22px", lineHeight: 1.3 }}>
            Tudo que você precisa para{" "}
            <span style={{ color: "#ff7a00" }}>vender mais e lucrar melhor</span>
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
            {[
              { icon: "🧮", title: "Precificação automática", desc: "Cálculos precisos de taxas, impostos e lucro líquido." },
              { icon: "📊", title: "Análise de margem", desc: "Veja sua margem de contribuição em tempo real." },
              { icon: "🕘", title: "Histórico inteligente", desc: "Acompanhe e edite seus cálculos sempre que quiser." },
              { icon: "🔗", title: "Integração com anúncios", desc: "Puxe dados direto dos marketplaces em segundos." },
              { icon: "📈", title: "Módulo de anúncios (Ads)", desc: "Controle seus gastos, vendas e resultados." },
              { icon: "🎯", title: "Estratégia e crescimento", desc: "Tome decisões melhores com dados reais." },
            ].map(({ icon, title, desc }) => (
              <div key={title} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                <div style={{
                  width: "36px", height: "36px", flexShrink: 0,
                  background: "rgba(255,122,0,0.1)", borderRadius: "9px",
                  display: "grid", placeItems: "center", fontSize: "17px",
                }}>{icon}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: "13px", marginBottom: "4px" }}>{title}</div>
                  <div style={{ fontSize: "12px", color: "#94a3b8", lineHeight: 1.5 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── SOCIAL PROOF BAR ── */}
      <div style={{
        margin: "0 56px 56px",
        background: "rgba(255,122,0,0.05)",
        border: "1px solid rgba(255,122,0,0.18)",
        borderRadius: "16px", padding: "18px 40px",
        display: "flex", alignItems: "center",
        gap: "0", justifyContent: "space-between",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <span style={{ fontSize: "26px" }}>👥</span>
          <span style={{ fontSize: "14px", color: "#d1d5db" }}>
            Mais de <strong style={{ color: "#ff7a00" }}>2.000 sellers</strong> já aumentaram seu lucro com a CDS
          </span>
        </div>

        <div style={{ width: "1px", height: "36px", background: "rgba(255,255,255,0.09)" }}/>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "20px" }}>🤝</span>
          <span style={{ fontWeight: 900, fontSize: "15px", color: "#ffe500", letterSpacing: "-0.5px" }}>mercado livre</span>
        </div>

        <div style={{ width: "1px", height: "36px", background: "rgba(255,255,255,0.09)" }}/>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "20px" }}>🛍️</span>
          <span style={{ fontWeight: 900, fontSize: "15px", color: "#ee4d2d" }}>Shopee</span>
        </div>

        <div style={{ width: "1px", height: "36px", background: "rgba(255,255,255,0.09)" }}/>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#d1d5db", fontSize: "13px" }}>
          <span style={{ fontSize: "18px" }}>🔒</span>
          Seus dados 100% seguros e confidenciais
        </div>
      </div>

    </div>
  );
}
