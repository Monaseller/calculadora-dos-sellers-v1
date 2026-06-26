import Link from "next/link";
import LandingHeader from "./components/LandingHeader";
import LandingFAQ from "./components/LandingFAQ";
import s from "./landing.module.css";

/* ── Shared tokens ───────────────────────────── */
const BG      = "#020817";
const CARD    = "#0F172A";
const BORDER  = "#1E293B";
const ORANGE  = "#FF7A00";
const YELLOW  = "#FFB000";
const TEXT    = "#FFFFFF";
const MUTED   = "#94A3B8";
const GREEN   = "#22C55E";
const pad     = "0 48px";

/* ── Helpers ─────────────────────────────────── */
function Section({ id, children, style = {} }: { id?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section id={id} className={s.sectionPad} style={{ padding: "96px 48px", ...style }}>
      <div style={{ maxWidth: "1280px", margin: "0 auto" }}>
        {children}
      </div>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: "8px",
      background: "rgba(255,122,0,0.08)", border: "1px solid rgba(255,122,0,0.2)",
      borderRadius: "999px", padding: "6px 16px",
      fontSize: "12px", fontWeight: 700, color: ORANGE,
      letterSpacing: "0.8px", textTransform: "uppercase",
      marginBottom: "20px",
    }}>{children}</div>
  );
}

function SectionTitle({ children, center = false }: { children: React.ReactNode; center?: boolean }) {
  return (
    <h2 className={s.sectionTitle} style={{
      fontSize: "42px", fontWeight: 900, margin: "0 0 16px",
      letterSpacing: "-1.5px", lineHeight: 1.12, color: TEXT,
      textAlign: center ? "center" : "left",
    }}>{children}</h2>
  );
}

function SectionSub({ children, center = false }: { children: React.ReactNode; center?: boolean }) {
  return (
    <p style={{
      fontSize: "18px", color: MUTED, lineHeight: 1.72,
      margin: center ? "0 auto 56px" : "0 0 56px",
      maxWidth: "600px", textAlign: center ? "center" : "left",
    }}>{children}</p>
  );
}

/* ── Mockup component ────────────────────────── */
function HeroMockup() {
  return (
    <div className={`${s.mockupWrap}`} style={{ position: "relative", paddingRight: "40px" }}>
      {/* Glow */}
      <div className={s.glowPulse} style={{
        position: "absolute", inset: "-80px",
        background: "radial-gradient(ellipse at center, rgba(255,122,0,0.14) 0%, transparent 68%)",
        pointerEvents: "none",
      }}/>

      {/* Main card */}
      <div className={s.mockupFloat} style={{
        background: CARD,
        border: `1px solid rgba(255,122,0,0.25)`,
        borderRadius: "22px",
        overflow: "hidden",
        boxShadow: "0 40px 100px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,122,0,0.06)",
        position: "relative", zIndex: 1,
      }}>
        {/* Window chrome */}
        <div style={{
          background: "#080D1A",
          borderBottom: `1px solid ${BORDER}`,
          padding: "12px 18px",
          display: "flex", alignItems: "center", gap: "12px",
        }}>
          <div style={{ display: "flex", gap: "6px" }}>
            {["#FF5F57","#FEBC2E","#28C840"].map(c => (
              <div key={c} style={{ width:"10px", height:"10px", borderRadius:"50%", background:c }}/>
            ))}
          </div>
          <div style={{
            flex: 1, background: "rgba(255,255,255,0.04)", borderRadius: "6px",
            padding: "4px 14px", fontSize: "11px", color: "#475569", textAlign: "center",
          }}>
            app.calculadoradossellers.com.br/precificacao
          </div>
          <div style={{
            background: "linear-gradient(135deg,#FF7A00,#FFB000)",
            borderRadius: "6px", padding: "3px 8px",
            fontSize: "10px", fontWeight: 800, color: "#000",
          }}>CDS</div>
        </div>

        <div style={{ display: "flex", height: "470px" }}>
          {/* Sidebar */}
          <div style={{
            width: "150px", background: "#06090F",
            borderRight: `1px solid ${BORDER}`,
            display: "flex", flexDirection: "column",
            padding: "12px 0", flexShrink: 0,
          }}>
            {[
              { icon: "🧮", label: "Calculadora", active: true },
              { icon: "📋", label: "Histórico" },
              { icon: "📢", label: "Anúncios" },
              { icon: "📦", label: "Produtos" },
              { icon: "📊", label: "Análises" },
              { icon: "📈", label: "Anúncios Ads" },
              { icon: "⚙️", label: "Config." },
            ].map(({ icon, label, active }) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: "8px",
                padding: "9px 14px",
                background: active ? "rgba(255,122,0,0.09)" : "transparent",
                borderLeft: `2px solid ${active ? ORANGE : "transparent"}`,
              }}>
                <span style={{ fontSize: "13px" }}>{icon}</span>
                <span style={{ fontSize: "11px", fontWeight: active ? 700 : 400, color: active ? ORANGE : "#475569" }}>
                  {label}
                </span>
              </div>
            ))}
          </div>

          {/* Main area */}
          <div style={{ flex: 1, padding: "16px", display: "flex", flexDirection: "column", gap: "10px", overflow: "hidden" }}>
            {/* Top row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: "13px", color: TEXT }}>Resultado da Precificação</div>
                <div style={{ fontSize: "10px", color: MUTED }}>Mercado Livre · Clássico · Ferramentas</div>
              </div>
              <div style={{
                background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)",
                borderRadius: "6px", padding: "3px 10px",
                fontSize: "9px", fontWeight: 800, color: GREEN, letterSpacing: "0.6px",
              }}>SAUDÁVEL</div>
            </div>

            {/* Product */}
            <div style={{
              background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`,
              borderRadius: "10px", padding: "10px 12px",
              display: "flex", gap: "10px", alignItems: "center",
            }}>
              <div style={{
                width: "44px", height: "44px", background: "#fff", borderRadius: "8px",
                display: "grid", placeItems: "center", fontSize: "20px", flexShrink: 0,
              }}>📦</div>
              <div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: TEXT }}>Kit 3 Pinças Profissional</div>
                <div style={{ fontSize: "10px", color: MUTED, marginTop: "2px" }}>Mercado Livre · SKU: KPP-001</div>
                <div style={{ fontSize: "10px", color: MUTED }}>Categoria: Ferramentas Manuais</div>
              </div>
            </div>

            {/* Metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
              {[
                { label: "Preço Ideal",    value: "R$ 116,90", green: false },
                { label: "Lucro Líquido",  value: "R$ 24,18",  green: true  },
                { label: "Margem",         value: "28,53%",    green: true  },
              ].map(m => (
                <div key={m.label} style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`,
                  borderRadius: "10px", padding: "10px",
                }}>
                  <div style={{ fontSize: "9px", color: MUTED, marginBottom: "4px" }}>{m.label}</div>
                  <div style={{ fontSize: "16px", fontWeight: 900, color: m.green ? GREEN : TEXT }}>{m.value}</div>
                </div>
              ))}
            </div>

            {/* Health bar */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", marginBottom: "5px" }}>
                <span style={{ color: MUTED }}>Saúde da venda</span>
                <span style={{ color: GREEN, fontWeight: 700 }}>Muito boa 😊</span>
              </div>
              <div style={{ height: "6px", background: "rgba(255,255,255,0.07)", borderRadius: "999px", overflow: "hidden" }}>
                <div style={{ width: "76%", height: "100%", background: "linear-gradient(90deg,#22C55E,#FACC15,#FF7A00)", borderRadius: "999px" }}/>
              </div>
            </div>

            {/* Prices */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
              {[
                { label: "Preço Original",        value: "R$ 116,90", sub: "Margem: 28,53%" },
                { label: "Com Promoção 20%",       value: "R$ 140,28", sub: "Margem: 33,65%" },
              ].map(p => (
                <div key={p.label} style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${BORDER}`,
                  borderRadius: "10px", padding: "10px",
                }}>
                  <div style={{ fontSize: "9px", color: MUTED, marginBottom: "3px" }}>{p.label}</div>
                  <div style={{ fontSize: "20px", fontWeight: 900, color: TEXT }}>{p.value}</div>
                  <div style={{ fontSize: "9px", color: MUTED, marginTop: "2px" }}>{p.sub}</div>
                </div>
              ))}
            </div>

            {/* Cost mini table */}
            <div style={{
              background: "rgba(255,255,255,0.02)", border: `1px solid ${BORDER}`,
              borderRadius: "10px", padding: "10px",
            }}>
              <div style={{ fontSize: "9px", fontWeight: 700, color: MUTED, marginBottom: "6px" }}>RESUMO DOS CUSTOS</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                {[
                  ["Comissão ML", "R$15,19"],
                  ["Impostos", "R$8,45"],
                  ["Custo do produto", "R$44,85"],
                  ["Frete", "R$16,85"],
                ].map(([k,v]) => (
                  <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: "10px" }}>
                    <span style={{ color: MUTED }}>{k}</span>
                    <span style={{ color: TEXT, fontWeight: 600 }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating badge — profit */}
      <div className={s.floatSlow} style={{
        position: "absolute", left: "-36px", top: "120px", zIndex: 10,
        background: CARD, border: "1px solid rgba(34,197,94,0.3)",
        borderRadius: "14px", padding: "14px 16px",
        boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 30px rgba(34,197,94,0.08)",
      }}>
        <div style={{ fontSize: "10px", color: MUTED, marginBottom: "4px" }}>Lucro líquido</div>
        <div style={{ fontSize: "22px", fontWeight: 900, color: GREEN }}>+R$ 24,18</div>
        <div style={{ fontSize: "10px", color: GREEN, marginTop: "2px" }}>↑ por venda</div>
      </div>

      {/* Floating badge — price */}
      <div style={{
        position: "absolute", right: "0px", bottom: "100px", zIndex: 10,
        background: CARD, border: `1px solid rgba(255,122,0,0.3)`,
        borderRadius: "14px", padding: "14px 16px",
        boxShadow: "0 20px 50px rgba(0,0,0,0.6), 0 0 30px rgba(255,122,0,0.08)",
      }}>
        <div style={{ fontSize: "10px", color: MUTED, marginBottom: "4px" }}>Margem real</div>
        <div style={{ fontSize: "22px", fontWeight: 900, color: ORANGE }}>28,53%</div>
        <div style={{ display: "flex", alignItems: "center", gap: "5px", marginTop: "3px" }}>
          <div style={{ width: "6px", height: "6px", borderRadius: "50%", background: GREEN }}/>
          <span style={{ fontSize: "10px", color: GREEN }}>ML Premium</span>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════
   PAGE
   ════════════════════════════════════════════════ */
export default function LandingPage() {
  return (
    <div style={{
      minHeight: "100vh",
      background: BG,
      color: TEXT,
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      overflowX: "hidden",
    }}>
      <LandingHeader />

      {/* ── HERO ── */}
      <section id="inicio" className={s.sectionPad} style={{ padding: "0 48px", paddingTop: "136px", paddingBottom: "80px", position: "relative", overflow: "hidden" }}>
        {/* Background glows */}
        <div style={{ position:"absolute", top:"-200px", right:"-100px", width:"700px", height:"700px", background:"radial-gradient(circle,rgba(255,122,0,0.10) 0%,transparent 65%)", pointerEvents:"none" }}/>
        <div style={{ position:"absolute", bottom:"-100px", left:"-100px", width:"500px", height:"500px", background:"radial-gradient(circle,rgba(255,176,0,0.06) 0%,transparent 65%)", pointerEvents:"none" }}/>

        <div className={s.heroGrid} style={{ maxWidth:"1280px", margin:"0 auto", display:"grid", gridTemplateColumns:"1fr 1.2fr", gap:"72px", alignItems:"center" }}>
          {/* Left */}
          <div>
            <div style={{
              display:"inline-flex", alignItems:"center", gap:"8px",
              background:"rgba(255,122,0,0.08)", border:"1px solid rgba(255,122,0,0.22)",
              borderRadius:"999px", padding:"7px 16px",
              fontSize:"12px", fontWeight:700, color:ORANGE, letterSpacing:"0.5px",
              marginBottom:"28px",
            }}>
              ⭐ A ferramenta nº1 para sellers de marketplace
            </div>

            <h1 className={s.heroTitle} style={{ fontSize:"64px", fontWeight:900, lineHeight:1.05, margin:"0 0 24px", letterSpacing:"-2px" }}>
              Precifique com{" "}
              <span className={s.gradientText}>inteligência.</span>
              <br />
              Venda com lucro<br/>de verdade.
            </h1>

            <p style={{ fontSize:"18px", color:MUTED, lineHeight:1.72, margin:"0 0 36px", maxWidth:"500px" }}>
              A Calculadora dos Sellers mostra exatamente quanto você realmente ganha em cada venda nos marketplaces.{" "}
              <strong style={{ color:TEXT }}>Chega de trabalhar sem saber sua margem.</strong>
            </p>

            <div className={s.heroBtns} style={{ display:"flex", gap:"12px", marginBottom:"48px", flexWrap:"wrap" }}>
              <Link href="/login" className={s.btnPrimary} style={{
                padding:"14px 28px", borderRadius:"11px",
                background:"linear-gradient(135deg,#FF7A00,#FFB000)",
                color:"#fff", fontWeight:800, fontSize:"16px", textDecoration:"none",
                boxShadow:"0 8px 32px rgba(255,122,0,0.4)",
              }}>⚡ Testar grátis por 1 dia</Link>
              <button className={s.btnSecondary} style={{
                padding:"14px 28px", borderRadius:"11px",
                border:"1px solid rgba(255,255,255,0.15)",
                background:"rgba(255,255,255,0.03)",
                color:TEXT, fontWeight:600, fontSize:"16px", cursor:"pointer",
              }}>▶ Ver demonstração</button>
            </div>

            {/* Stats strip */}
            <div className={s.statStrip} style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"0", paddingTop:"32px", borderTop:"1px solid rgba(255,255,255,0.07)" }}>
              {[
                { n:"+2.000",  l:"sellers ativos" },
                { n:"+500 mil", l:"cálculos realizados" },
                { n:"Milhões",  l:"em faturamento analisados" },
              ].map(({ n, l }, i) => (
                <div key={n} style={{ paddingLeft: i > 0 ? "28px" : 0, borderLeft: i > 0 ? "1px solid rgba(255,255,255,0.07)" : "none" }}>
                  <div style={{ fontSize:"28px", fontWeight:900, color:ORANGE, lineHeight:1 }}>{n}</div>
                  <div style={{ fontSize:"12px", color:MUTED, marginTop:"4px" }}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right — Mockup */}
          <HeroMockup />
        </div>
      </section>

      {/* ── DIVIDER ── */}
      <div className={s.shimmerDivider} style={{ margin:"0 48px" }}/>

      {/* ── VIDEO ── */}
      <Section id="como-funciona" style={{ paddingTop:"96px", paddingBottom:"96px" }}>
        <div style={{ textAlign:"center", marginBottom:"48px" }}>
          <SectionLabel>Demonstração</SectionLabel>
          <SectionTitle center>
            Veja em menos de{" "}
            <span className={s.gradientText}>2 minutos</span>{" "}
            como aumentar seu lucro
          </SectionTitle>
          <SectionSub center>
            Assista ao vídeo e entenda como a CDS vai transformar seus resultados do dia pra noite.
          </SectionSub>
        </div>

        <div style={{
          maxWidth:"920px", margin:"0 auto",
          background:CARD, border:`1px solid ${BORDER}`,
          borderRadius:"22px", overflow:"hidden",
          boxShadow:"0 40px 100px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,122,0,0.06)",
          position:"relative",
        }}>
          {/* Fake video bg */}
          <div style={{
            height:"480px",
            background:"linear-gradient(135deg,#06090F,#0D1117)",
            display:"grid", placeItems:"center", position:"relative",
          }}>
            {/* Decorative grid */}
            <div style={{
              position:"absolute", inset:0,
              backgroundImage:"linear-gradient(rgba(255,255,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.03) 1px,transparent 1px)",
              backgroundSize:"40px 40px",
              mask:"radial-gradient(ellipse at center,black 20%,transparent 80%)",
            }}/>
            {/* Glow */}
            <div style={{
              position:"absolute", top:"50%", left:"50%",
              transform:"translate(-50%,-50%)",
              width:"400px", height:"400px",
              background:"radial-gradient(circle,rgba(255,122,0,0.12) 0%,transparent 65%)",
              pointerEvents:"none",
            }}/>
            {/* Play button */}
            <div style={{ position:"relative", zIndex:1, textAlign:"center" }}>
              <button className={s.playBtn} style={{
                width:"88px", height:"88px", borderRadius:"50%",
                background:"linear-gradient(135deg,#FF7A00,#FFB000)",
                border:"none", color:"#fff", fontSize:"32px",
                cursor:"pointer", display:"grid", placeItems:"center",
                boxShadow:"0 12px 44px rgba(255,122,0,0.5)",
                marginBottom:"20px",
              }}>▶</button>
              <div style={{ fontSize:"15px", color:MUTED }}>
                Em breve — vídeo completo disponível
              </div>
            </div>
          </div>
          {/* Video controls bar */}
          <div style={{
            padding:"12px 20px", background:"#06090F",
            display:"flex", alignItems:"center", gap:"12px",
            borderTop:`1px solid ${BORDER}`,
          }}>
            <span style={{ fontSize:"14px", color:MUTED }}>▶</span>
            <span style={{ fontSize:"10px", color:MUTED, whiteSpace:"nowrap" }}>0:00 / 2:00</span>
            <div style={{ flex:1, height:"3px", background:"rgba(255,255,255,0.1)", borderRadius:"2px" }}>
              <div style={{ width:"0%", height:"100%", background:ORANGE, borderRadius:"2px" }}/>
            </div>
            <span style={{ fontSize:"13px", color:MUTED }}>🔊</span>
            <span style={{ fontSize:"13px", color:MUTED }}>⛶</span>
          </div>
        </div>
      </Section>

      {/* ── BENEFITS ── */}
      <Section id="recursos">
        <div style={{ textAlign:"center" }}>
          <SectionLabel>Recursos</SectionLabel>
          <SectionTitle center>
            Tudo que você precisa para{" "}
            <span className={s.gradientText}>vender com lucro</span>
          </SectionTitle>
          <SectionSub center>
            Chega de planilha, chute e achismo. A CDS entrega dados reais em segundos.
          </SectionSub>
        </div>

        <div className={s.benefitGrid} style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"20px" }}>
          {[
            {
              icon: "🧮",
              title: "Precificação Inteligente",
              desc: "Cole o link do anúncio e receba automaticamente o preço ideal para lucrar em qualquer marketplace.",
            },
            {
              icon: "📊",
              title: "Margem Automática",
              desc: "Calcule sua margem real descontando comissões, taxas, impostos, frete e custo do produto.",
            },
            {
              icon: "🔗",
              title: "Integração Mercado Livre",
              desc: "Conecte sua conta ML e importe anúncios com um clique. Dados sincronizados em tempo real.",
            },
            {
              icon: "📋",
              title: "Histórico Completo",
              desc: "Todos os seus cálculos salvos e organizados. Compare datas, evolua preços e tome decisões.",
            },
            {
              icon: "💹",
              title: "Análise Financeira",
              desc: "Visão geral do faturamento, lucro acumulado e margem média de toda a sua operação.",
            },
            {
              icon: "🎯",
              title: "Preço Ideal com Promoção",
              desc: "Simule descontos e veja o preço exato para manter lucro mesmo em promoção ou cupom.",
            },
          ].map(({ icon, title, desc }) => (
            <div key={title} className={s.featureCard} style={{
              background: CARD, border:`1px solid ${BORDER}`,
              borderRadius:"18px", padding:"28px",
              boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
            }}>
              <div style={{
                width:"52px", height:"52px", borderRadius:"14px",
                background:"rgba(255,122,0,0.1)", border:"1px solid rgba(255,122,0,0.18)",
                display:"grid", placeItems:"center", fontSize:"24px",
                marginBottom:"18px",
              }}>{icon}</div>
              <div style={{ fontWeight:800, fontSize:"17px", marginBottom:"10px", color:TEXT }}>{title}</div>
              <div style={{ fontSize:"14px", color:MUTED, lineHeight:1.7 }}>{desc}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── HOW IT WORKS ── */}
      <Section style={{ background:"rgba(255,255,255,0.015)", borderTop:`1px solid ${BORDER}`, borderBottom:`1px solid ${BORDER}` }}>
        <div style={{ textAlign:"center" }}>
          <SectionLabel>Como funciona</SectionLabel>
          <SectionTitle center>
            Do link ao lucro em{" "}
            <span className={s.gradientText}>4 passos</span>
          </SectionTitle>
          <SectionSub center>
            Sem configuração, sem complicação. Você começa a usar em menos de 1 minuto.
          </SectionSub>
        </div>

        <div className={s.howGrid} style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"0", position:"relative" }}>
          {/* Connector line */}
          <div style={{
            position:"absolute", top:"52px", left:"12.5%", right:"12.5%", height:"2px",
            background:"linear-gradient(90deg,transparent,rgba(255,122,0,0.4),rgba(255,176,0,0.4),rgba(255,122,0,0.4),transparent)",
            pointerEvents:"none",
          }}/>

          {[
            { n:"01", icon:"🔗", title:"Cole o link", desc:"Cole o link do seu anúncio do Mercado Livre, Shopee, Amazon ou Magalu." },
            { n:"02", icon:"⚡", title:"CDS identifica", desc:"Importamos automaticamente título, categoria, imagem e preço atual." },
            { n:"03", icon:"💰", title:"Informe seus custos", desc:"Adicione custo do produto, frete, impostos e outros custos variáveis." },
            { n:"04", icon:"🎯", title:"Receba o preço ideal", desc:"Receba o preço ideal, margem real e simulação de promoção em segundos." },
          ].map(({ n, icon, title, desc }) => (
            <div key={n} className={s.stepItem} style={{ padding:"0 24px", textAlign:"center" }}>
              <div className="stepIcon" style={{
                width:"60px", height:"60px", borderRadius:"18px",
                background:"rgba(255,122,0,0.08)", border:`1px solid rgba(255,122,0,0.22)`,
                display:"grid", placeItems:"center", fontSize:"26px",
                margin:"0 auto 20px",
              }}>{icon}</div>
              <div style={{
                fontSize:"11px", fontWeight:800, color:ORANGE,
                letterSpacing:"1px", marginBottom:"8px",
              }}>PASSO {n}</div>
              <div style={{ fontWeight:800, fontSize:"16px", marginBottom:"8px", color:TEXT }}>{title}</div>
              <div style={{ fontSize:"13px", color:MUTED, lineHeight:1.65 }}>{desc}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── RESULTS ── */}
      <Section id="resultados">
        <div style={{ textAlign:"center" }}>
          <SectionLabel>Resultados</SectionLabel>
          <SectionTitle center>
            O que muda na sua operação
          </SectionTitle>
          <SectionSub center>
            Sellers que usam a CDS relatam resultados em poucos dias de uso.
          </SectionSub>
        </div>

        <div className={s.resultGrid} style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"20px" }}>
          {[
            { icon:"💰", value:"+40%",   label:"de lucro líquido", color:GREEN },
            { icon:"📊", value:"100%",   label:"de controle da margem", color:ORANGE },
            { icon:"⚡", value:"10x",    label:"mais rápido que planilha", color:YELLOW },
            { icon:"🛡️", value:"Zero",   label:"erros de precificação", color:"#60A5FA" },
          ].map(({ icon, value, label, color }) => (
            <div key={label} className={s.resultCard} style={{
              background:CARD, border:`1px solid ${BORDER}`,
              borderRadius:"18px", padding:"32px 24px",
              textAlign:"center",
              boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
            }}>
              <div style={{ fontSize:"32px", marginBottom:"12px" }}>{icon}</div>
              <div style={{ fontSize:"44px", fontWeight:900, color, lineHeight:1, marginBottom:"8px" }}>{value}</div>
              <div style={{ fontSize:"13px", color:MUTED, lineHeight:1.5 }}>{label}</div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── TESTIMONIALS ── */}
      <Section style={{ background:"rgba(255,255,255,0.015)", borderTop:`1px solid ${BORDER}`, borderBottom:`1px solid ${BORDER}` }}>
        <div style={{ textAlign:"center" }}>
          <SectionLabel>Depoimentos</SectionLabel>
          <SectionTitle center>
            Sellers que já vendem com{" "}
            <span className={s.gradientText}>mais lucro</span>
          </SectionTitle>
          <SectionSub center>
            Mais de 2.000 vendedores já usam a CDS no dia a dia.
          </SectionSub>
        </div>

        <div className={s.testGrid} style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"20px" }}>
          {[
            {
              avatar:"JC",
              name:"João Carlos Silva",
              role:"Seller ML • 4 anos de operação",
              text:"\"Antes eu precificava no chute e nem sabia que estava tendo prejuízo. Com a CDS, aumentei meu lucro real em mais de 35% no primeiro mês. Não consigo mais vender sem ela.\"",
              stars:5,
            },
            {
              avatar:"MS",
              name:"Maria Santos",
              role:"Dropshipper • Shopee & ML",
              text:"\"Finalmente entendo minha margem real em cada marketplace. O cálculo automático com taxas e comissões me economiza horas toda semana. Vale muito o investimento.\"",
              stars:5,
            },
            {
              avatar:"CO",
              name:"Carlos Oliveira",
              role:"Multi-marketplace • Amazon & Magalu",
              text:"\"Já usei várias ferramentas, mas a CDS é a única que realmente entrega resultado. Interface clean, dados precisos e suporte excelente. Recomendo para qualquer seller sério.\"",
              stars:5,
            },
          ].map(({ avatar, name, role, text, stars }) => (
            <div key={name} className={s.testCard} style={{
              background:CARD, border:`1px solid ${BORDER}`,
              borderRadius:"20px", padding:"28px",
              boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
              display:"flex", flexDirection:"column", gap:"16px",
            }}>
              <div style={{ color:ORANGE, fontSize:"18px" }}>{"★".repeat(stars)}</div>
              <p style={{ fontSize:"14px", color:MUTED, lineHeight:1.78, margin:0 }}>{text}</p>
              <div style={{ display:"flex", alignItems:"center", gap:"12px", marginTop:"auto", paddingTop:"16px", borderTop:`1px solid ${BORDER}` }}>
                <div style={{
                  width:"42px", height:"42px", borderRadius:"50%",
                  background:"linear-gradient(135deg,#FF7A00,#FFB000)",
                  display:"grid", placeItems:"center",
                  fontSize:"14px", fontWeight:800, color:"#000", flexShrink:0,
                }}>{avatar}</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:"14px", color:TEXT }}>{name}</div>
                  <div style={{ fontSize:"12px", color:MUTED }}>{role}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── PRICING ── */}
      <Section id="planos">
        <div style={{ textAlign:"center" }}>
          <SectionLabel>Planos</SectionLabel>
          <SectionTitle center>
            Invista no seu{" "}
            <span className={s.gradientText}>lucro real</span>
          </SectionTitle>
          <SectionSub center>
            Comece grátis, escale quando quiser. Sem contrato, sem surpresa.
          </SectionSub>
        </div>

        <div className={s.planGrid} style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:"20px", maxWidth:"1060px", margin:"0 auto" }}>
          {/* Gratuito */}
          <div className={s.planCard} style={{
            background:CARD, border:`1px solid ${BORDER}`,
            borderRadius:"22px", padding:"32px",
            boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
            display:"flex", flexDirection:"column",
          }}>
            <div style={{ fontWeight:800, fontSize:"14px", color:MUTED, letterSpacing:"1px", marginBottom:"10px" }}>GRATUITO</div>
            <div style={{ marginBottom:"6px" }}>
              <span style={{ fontSize:"42px", fontWeight:900, color:TEXT }}>R$ 0</span>
            </div>
            <div style={{ fontSize:"13px", color:MUTED, marginBottom:"28px" }}>1 dia de acesso completo</div>
            <div style={{ display:"flex", flexDirection:"column", gap:"10px", flex:1, marginBottom:"28px" }}>
              {["✓ Calculadora de preço","✓ 1 dia de acesso completo","✓ Sem cartão de crédito","✓ Todos os marketplaces","✗ Histórico de cálculos","✗ Integração ML avançada"].map(f => (
                <div key={f} style={{ display:"flex", alignItems:"center", gap:"8px", fontSize:"14px", color: f.startsWith("✗") ? "#334155" : MUTED }}>
                  {f}
                </div>
              ))}
            </div>
            <Link href="/login" style={{
              padding:"13px", borderRadius:"11px", textAlign:"center",
              border:`1px solid ${BORDER}`, color:MUTED,
              fontWeight:700, fontSize:"14px", textDecoration:"none",
              transition:"all 0.2s",
            }}>Começar grátis</Link>
          </div>

          {/* PRO — destacado */}
          <div className={s.planCard} style={{
            background:"linear-gradient(160deg,rgba(255,122,0,0.08),rgba(255,176,0,0.05))",
            border:"1px solid rgba(255,122,0,0.4)",
            borderRadius:"22px", padding:"32px",
            boxShadow:"0 0 60px rgba(255,122,0,0.12), 0 24px 60px rgba(0,0,0,0.5)",
            display:"flex", flexDirection:"column", position:"relative",
          }}>
            <div style={{
              position:"absolute", top:"-13px", left:"50%", transform:"translateX(-50%)",
              background:"linear-gradient(135deg,#FF7A00,#FFB000)",
              borderRadius:"999px", padding:"5px 18px",
              fontSize:"11px", fontWeight:800, color:"#000", letterSpacing:"0.5px", whiteSpace:"nowrap",
            }}>⚡ MAIS POPULAR</div>
            <div style={{ fontWeight:800, fontSize:"14px", color:ORANGE, letterSpacing:"1px", marginBottom:"10px" }}>PRO</div>
            <div style={{ marginBottom:"6px" }}>
              <span style={{ fontSize:"42px", fontWeight:900, color:TEXT }}>R$ 47</span>
              <span style={{ fontSize:"16px", color:MUTED }}>/mês</span>
            </div>
            <div style={{ fontSize:"13px", color:MUTED, marginBottom:"28px" }}>Acesso total, cancele quando quiser</div>
            <div style={{ display:"flex", flexDirection:"column", gap:"10px", flex:1, marginBottom:"28px" }}>
              {[
                "✓ Tudo do plano Gratuito",
                "✓ Histórico ilimitado",
                "✓ Integração Mercado Livre",
                "✓ Integração Shopee",
                "✓ Módulo de Anúncios",
                "✓ Análise financeira avançada",
                "✓ Suporte prioritário",
              ].map(f => (
                <div key={f} style={{ display:"flex", alignItems:"center", gap:"8px", fontSize:"14px", color:TEXT }}>
                  {f}
                </div>
              ))}
            </div>
            <Link href="/login" style={{
              padding:"14px", borderRadius:"11px", textAlign:"center",
              background:"linear-gradient(135deg,#FF7A00,#FFB000)",
              color:"#fff", fontWeight:800, fontSize:"15px", textDecoration:"none",
              boxShadow:"0 8px 28px rgba(255,122,0,0.4)",
              transition:"all 0.2s",
            }}>Assinar o PRO →</Link>
          </div>

          {/* Lifetime */}
          <div className={s.planCard} style={{
            background:CARD, border:`1px solid ${BORDER}`,
            borderRadius:"22px", padding:"32px",
            boxShadow:"0 4px 24px rgba(0,0,0,0.3)",
            display:"flex", flexDirection:"column",
          }}>
            <div style={{ fontWeight:800, fontSize:"14px", color:YELLOW, letterSpacing:"1px", marginBottom:"10px" }}>LIFETIME</div>
            <div style={{ marginBottom:"6px" }}>
              <span style={{ fontSize:"42px", fontWeight:900, color:TEXT }}>R$ 297</span>
            </div>
            <div style={{ fontSize:"13px", color:MUTED, marginBottom:"28px" }}>Pagamento único • acesso para sempre</div>
            <div style={{ display:"flex", flexDirection:"column", gap:"10px", flex:1, marginBottom:"28px" }}>
              {[
                "✓ Tudo do plano PRO",
                "✓ Acesso vitalício",
                "✓ Todas as atualizações futuras",
                "✓ Novos marketplaces incluídos",
                "✓ Sem mensalidade nunca mais",
                "✓ Badge exclusivo de fundador",
                "✓ Acesso antecipado a novidades",
              ].map(f => (
                <div key={f} style={{ display:"flex", alignItems:"center", gap:"8px", fontSize:"14px", color:MUTED }}>
                  {f}
                </div>
              ))}
            </div>
            <Link href="/login" style={{
              padding:"13px", borderRadius:"11px", textAlign:"center",
              background:"rgba(255,176,0,0.1)", border:"1px solid rgba(255,176,0,0.3)",
              color:YELLOW, fontWeight:700, fontSize:"14px", textDecoration:"none",
              transition:"all 0.2s",
            }}>Garantir Lifetime →</Link>
          </div>
        </div>
      </Section>

      {/* ── FAQ ── */}
      <Section id="faq" style={{ background:"rgba(255,255,255,0.015)", borderTop:`1px solid ${BORDER}`, borderBottom:`1px solid ${BORDER}` }}>
        <div style={{ textAlign:"center" }}>
          <SectionLabel>FAQ</SectionLabel>
          <SectionTitle center>Dúvidas frequentes</SectionTitle>
          <SectionSub center>Tudo que você precisa saber antes de começar.</SectionSub>
        </div>
        <LandingFAQ />
      </Section>

      {/* ── CTA ── */}
      <Section id="contato">
        <div style={{
          maxWidth:"860px", margin:"0 auto",
          background:"linear-gradient(135deg,rgba(255,122,0,0.09),rgba(255,176,0,0.05))",
          border:"1px solid rgba(255,122,0,0.25)",
          borderRadius:"28px", padding:"72px 56px",
          textAlign:"center", position:"relative", overflow:"hidden",
          boxShadow:"0 0 80px rgba(255,122,0,0.08)",
        }}>
          {/* Decorative glow */}
          <div style={{
            position:"absolute", top:"-60px", left:"50%", transform:"translateX(-50%)",
            width:"500px", height:"300px",
            background:"radial-gradient(ellipse,rgba(255,122,0,0.15),transparent 65%)",
            pointerEvents:"none",
          }}/>

          <SectionLabel>Comece agora</SectionLabel>
          <h2 style={{ fontSize:"52px", fontWeight:900, margin:"16px 0 20px", letterSpacing:"-2px", lineHeight:1.08, color:TEXT }}>
            Pronto para vender com{" "}
            <span className={s.gradientText}>lucro de verdade?</span>
          </h2>
          <p style={{ fontSize:"18px", color:MUTED, margin:"0 auto 40px", maxWidth:"540px", lineHeight:1.7 }}>
            Crie sua conta grátis agora e descubra em segundos se você está lucrando ou perdendo dinheiro em cada venda.
          </p>
          <div style={{ display:"flex", gap:"14px", justifyContent:"center", flexWrap:"wrap" }}>
            <Link href="/login" className={s.btnPrimary} style={{
              padding:"16px 36px", borderRadius:"12px",
              background:"linear-gradient(135deg,#FF7A00,#FFB000)",
              color:"#fff", fontWeight:800, fontSize:"17px", textDecoration:"none",
              boxShadow:"0 10px 40px rgba(255,122,0,0.45)",
            }}>Criar conta grátis →</Link>
            <Link href="/login" className={s.btnSecondary} style={{
              padding:"16px 28px", borderRadius:"12px",
              border:"1px solid rgba(255,255,255,0.15)",
              background:"rgba(255,255,255,0.04)",
              color:TEXT, fontWeight:600, fontSize:"17px", textDecoration:"none",
            }}>Ver demonstração</Link>
          </div>
          <p style={{ fontSize:"13px", color:"#475569", marginTop:"20px" }}>
            Sem cartão de crédito · Sem compromisso · Cancele quando quiser
          </p>
        </div>
      </Section>

      {/* ── FOOTER ── */}
      <footer style={{
        borderTop:`1px solid ${BORDER}`,
        padding:"60px 48px 40px",
      }}>
        <div style={{ maxWidth:"1280px", margin:"0 auto" }}>
          <div className={s.footerGrid} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", gap:"48px", marginBottom:"48px" }}>

            {/* Brand col */}
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"16px" }}>
                <div style={{
                  width:"36px", height:"36px", borderRadius:"10px",
                  background:"linear-gradient(135deg,#FF7A00,#FFB000)",
                  display:"grid", placeItems:"center",
                  fontSize:"17px", fontWeight:900, color:"#020817",
                }}>C</div>
                <div>
                  <div style={{ fontWeight:800, fontSize:"14px", color:TEXT }}>CDS</div>
                  <div style={{ fontSize:"8px", color:"#475569", letterSpacing:"1px" }}>CALCULADORA DOS SELLERS</div>
                </div>
              </div>
              <p style={{ fontSize:"14px", color:MUTED, lineHeight:1.72, margin:"0 0 20px", maxWidth:"280px" }}>
                A ferramenta nº1 para sellers de marketplace que querem vender com lucro de verdade.
              </p>
              <div style={{ display:"flex", gap:"8px" }}>
                {["𝕏","in","📱"].map(i => (
                  <a key={i} className={s.socialIcon} href="#">{i}</a>
                ))}
              </div>
            </div>

            {/* Links */}
            {[
              {
                title:"Produto",
                links:["Recursos","Como funciona","Planos","Novidades"],
              },
              {
                title:"Empresa",
                links:["Sobre nós","Blog","Termos de uso","Privacidade"],
              },
              {
                title:"Suporte",
                links:["Central de ajuda","Contato","Status","API"],
              },
            ].map(({ title, links }) => (
              <div key={title}>
                <div style={{ fontWeight:700, fontSize:"13px", color:TEXT, marginBottom:"16px", letterSpacing:"0.3px" }}>{title}</div>
                <div style={{ display:"flex", flexDirection:"column", gap:"10px" }}>
                  {links.map(l => (
                    <a key={l} href="#" className={s.footerLink}>{l}</a>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div style={{ borderTop:`1px solid ${BORDER}`, paddingTop:"28px", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:"12px" }}>
            <div style={{ fontSize:"13px", color:"#334155" }}>
              © {new Date().getFullYear()} Calculadora dos Sellers. Todos os direitos reservados.
            </div>
            <div style={{ fontSize:"13px", color:"#334155" }}>
              Feito com ❤️ para sellers brasileiros
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
