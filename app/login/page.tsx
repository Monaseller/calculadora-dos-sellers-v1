"use client";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ── Dados dos features ────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
      </svg>
    ),
    titulo: "Precificação inteligente",
    desc:   "Calcule o preço ideal considerando comissões, frete e margem de lucro para ML e Shopee.",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    ),
    titulo: "Gestão de anúncios",
    desc:   "Importe e gerencie todos seus produtos do Mercado Livre e Shopee em um único lugar.",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    ),
    titulo: "Vendas em tempo real",
    desc:   "Acompanhe faturamento, margem de contribuição e lucro de cada venda do dia.",
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
    ),
    titulo: "Multi-loja",
    desc:   "Conecte múltiplas contas de marketplace e alterne entre elas com um clique.",
  },
];

const STATS = [
  { valor: "100%",  label: "Grátis para começar" },
  { valor: "2",     label: "Marketplaces" },
  { valor: "∞",     label: "Anúncios" },
];

// ── Componente do painel esquerdo ─────────────────────────────────────────────
function PainelEsquerdo() {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column", justifyContent: "center",
      padding: "60px 56px", position: "relative", overflow: "hidden",
    }}>
      {/* Glow de fundo */}
      <div style={{
        position: "absolute", top: "-120px", left: "-80px",
        width: "500px", height: "500px", borderRadius: "50%",
        background: "radial-gradient(circle, rgba(255,182,0,0.12) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: "-100px", right: "-60px",
        width: "400px", height: "400px", borderRadius: "50%",
        background: "radial-gradient(circle, rgba(255,107,0,0.08) 0%, transparent 70%)",
        pointerEvents: "none",
      }} />

      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "52px" }}>
        <div style={{
          width: "48px", height: "48px", borderRadius: "13px",
          background: "linear-gradient(135deg, #FFB600, #FF6B00)",
          display: "grid", placeItems: "center",
          fontSize: "20px", fontWeight: 900, color: "#000", flexShrink: 0,
        }}>
          C
        </div>
        <div>
          <div style={{ fontWeight: 900, fontSize: "17px", color: "#fff" }}>Calculadora dos Sellers</div>
          <div style={{ fontSize: "12px", color: "#9099aa" }}>Sua central de gestão para marketplaces</div>
        </div>
      </div>

      {/* Headline */}
      <h1 style={{
        fontSize: "38px", fontWeight: 900, lineHeight: 1.15,
        color: "#fff", margin: "0 0 16px 0",
      }}>
        Venda mais,{" "}
        <span style={{
          background: "linear-gradient(90deg, #FFB600, #FF6B00)",
          WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
        }}>
          lucre mais.
        </span>
      </h1>
      <p style={{ fontSize: "15px", color: "#9099aa", lineHeight: 1.7, margin: "0 0 40px 0", maxWidth: "420px" }}>
        Tudo que você precisa para precificar corretamente, acompanhar suas vendas e escalar seu negócio nos maiores marketplaces do Brasil.
      </p>

      {/* Stats */}
      <div style={{ display: "flex", gap: "32px", marginBottom: "44px" }}>
        {STATS.map(s => (
          <div key={s.label}>
            <div style={{ fontSize: "26px", fontWeight: 900, color: "#FFB600" }}>{s.valor}</div>
            <div style={{ fontSize: "11px", color: "#9099aa", marginTop: "2px" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Features */}
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {FEATURES.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "16px" }}>
            <div style={{
              width: "40px", height: "40px", borderRadius: "11px", flexShrink: 0,
              background: "rgba(255,182,0,0.10)", border: "1px solid rgba(255,182,0,0.18)",
              display: "grid", placeItems: "center", color: "#FFB600",
            }}>
              {f.icon}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "#fff", marginBottom: "3px" }}>{f.titulo}</div>
              <div style={{ fontSize: "13px", color: "#9099aa", lineHeight: 1.5 }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Marketplaces badges */}
      <div style={{ display: "flex", gap: "10px", marginTop: "40px" }}>
        {[
          { label: "Mercado Livre", cor: "#FFE000", bg: "rgba(255,224,0,0.08)", emoji: "🛒" },
          { label: "Shopee",        cor: "#EE4D2D", bg: "rgba(238,77,45,0.08)", emoji: "🛍️" },
        ].map(m => (
          <div key={m.label} style={{
            display: "flex", alignItems: "center", gap: "7px",
            background: m.bg, border: `1px solid ${m.cor}33`,
            borderRadius: "8px", padding: "6px 12px",
            fontSize: "12px", fontWeight: 700, color: m.cor,
          }}>
            {m.emoji} {m.label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Componente principal (com hooks) ─────────────────────────────────────────
function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const redirect     = searchParams.get("redirect") || "/dashboard";

  const [tab,       setTab]       = useState<"login" | "criar">("login");
  const [email,     setEmail]     = useState("");
  const [senha,     setSenha]     = useState("");
  const [nome,      setNome]      = useState("");
  const [usuario,   setUsuario]   = useState("");
  const [documento, setDocumento] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [erro,      setErro]      = useState("");

  useEffect(() => {
    fetch("/api/auth/status-session")
      .then(r => { if (r.ok) router.replace(redirect); })
      .catch(() => {});
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setErro(""); setLoading(true);
    const res = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha }),
    });
    setLoading(false);
    if (res.ok) { router.replace(redirect); return; }
    const data = await res.json();
    if (res.status === 404) { setTab("criar"); setErro("Nenhuma conta encontrada. Crie sua conta abaixo."); }
    else setErro(data.erro || "Email ou senha incorretos.");
  }

  async function handleCriar(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    if (!email || !senha || !nome) { setErro("Nome, email e senha são obrigatórios."); return; }
    setLoading(true);
    const resPerfil = await fetch("/api/perfil", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome_completo: nome, usuario, email, documento, senha }),
    });
    if (!resPerfil.ok) { setLoading(false); setErro("Erro ao criar conta."); return; }
    const resLogin = await fetch("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha }),
    });
    setLoading(false);
    if (resLogin.ok) router.replace(redirect);
    else { setErro("Conta criada! Faça login."); setTab("login"); }
  }

  const inp: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "10px", padding: "11px 14px", color: "#fff", fontSize: "14px", outline: "none",
  };

  function Field({ label, value, onChange, type = "text", placeholder = "", required = false }: {
    label: string; value: string; onChange: (v: string) => void;
    type?: string; placeholder?: string; required?: boolean;
  }) {
    return (
      <div>
        <label style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "5px", textTransform: "uppercase", letterSpacing: "0.4px" }}>
          {label}{required && <span style={{ color: "#FFB600" }}> *</span>}
        </label>
        <input
          type={type} value={value} onChange={e => onChange(e.target.value)}
          placeholder={placeholder} required={required} style={inp}
          onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
          onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
        />
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", minHeight: "100vh",
      background: "#0d0e12",
    }}>
      {/* ── Painel esquerdo (features) ── */}
      <div style={{
        flex: 1, display: "none",
        borderRight: "1px solid rgba(255,255,255,0.06)",
      }}
        className="login-left"
      >
        <PainelEsquerdo />
      </div>

      {/* ── Painel direito (form) ── */}
      <div style={{
        width: "460px", flexShrink: 0,
        display: "flex", flexDirection: "column", justifyContent: "center",
        padding: "40px 40px",
        background: "rgba(255,255,255,0.02)",
        borderLeft: "1px solid rgba(255,255,255,0.06)",
        position: "relative",
        overflowY: "auto",
      }}>
        {/* Glow topo */}
        <div style={{
          position: "absolute", top: "-80px", right: "-80px",
          width: "300px", height: "300px", borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,182,0,0.08) 0%, transparent 70%)",
          pointerEvents: "none",
        }} />

        {/* Mobile: logo só no form */}
        <div style={{ marginBottom: "36px" }} className="login-mobile-logo">
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{
              width: "42px", height: "42px", borderRadius: "11px",
              background: "linear-gradient(135deg, #FFB600, #FF6B00)",
              display: "grid", placeItems: "center",
              fontSize: "18px", fontWeight: 900, color: "#000",
            }}>C</div>
            <div style={{ fontWeight: 900, fontSize: "16px", color: "#fff" }}>Calculadora dos Sellers</div>
          </div>
        </div>

        <div style={{ marginBottom: "28px" }}>
          <h2 style={{ fontSize: "22px", fontWeight: 900, color: "#fff", margin: "0 0 6px 0" }}>
            {tab === "login" ? "Bem-vindo de volta" : "Crie sua conta"}
          </h2>
          <p style={{ fontSize: "13px", color: "#9099aa", margin: 0 }}>
            {tab === "login"
              ? "Entre com suas credenciais para acessar o painel."
              : "Preencha os dados abaixo para começar a usar."}
          </p>
        </div>

        {/* Tabs */}
        <div style={{
          display: "flex", background: "rgba(255,255,255,0.04)", borderRadius: "10px",
          padding: "4px", marginBottom: "24px",
        }}>
          {(["login", "criar"] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setErro(""); }} style={{
              flex: 1, padding: "8px", borderRadius: "7px", border: "none",
              background: tab === t ? "rgba(255,182,0,0.12)" : "transparent",
              color: tab === t ? "#FFB600" : "#9099aa",
              fontWeight: 700, fontSize: "13px", cursor: "pointer",
              transition: "all 0.15s",
            }}>
              {t === "login" ? "Entrar" : "Criar conta"}
            </button>
          ))}
        </div>

        {/* Erro */}
        {erro && (
          <div style={{
            background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.25)",
            borderRadius: "8px", padding: "10px 14px", color: "#ff7070",
            fontSize: "13px", marginBottom: "18px",
          }}>
            {erro}
          </div>
        )}

        {/* Form Login */}
        {tab === "login" && (
          <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="seu@email.com" required />
            <Field label="Senha" value={senha} onChange={setSenha} type="password" placeholder="••••••••" required />
            <button type="submit" disabled={loading} style={{
              marginTop: "6px", padding: "13px", borderRadius: "10px", border: "none",
              background: loading ? "rgba(255,182,0,0.35)" : "linear-gradient(135deg, #FFB600, #FF6B00)",
              color: "#000", fontWeight: 800, fontSize: "15px",
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: loading ? "none" : "0 4px 24px rgba(255,182,0,0.25)",
            }}>
              {loading ? "Entrando..." : "Entrar →"}
            </button>
          </form>
        )}

        {/* Form Criar */}
        {tab === "criar" && (
          <form onSubmit={handleCriar} style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
            <Field label="Nome completo" value={nome} onChange={setNome} placeholder="Seu nome completo" required />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
              <Field label="Usuário" value={usuario} onChange={setUsuario} placeholder="@usuario" />
              <Field label="CPF / CNPJ" value={documento} onChange={setDocumento} placeholder="000.000.000-00" />
            </div>
            <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="seu@email.com" required />
            <Field label="Senha" value={senha} onChange={setSenha} type="password" placeholder="Mínimo 6 caracteres" required />
            <button type="submit" disabled={loading} style={{
              marginTop: "6px", padding: "13px", borderRadius: "10px", border: "none",
              background: loading ? "rgba(255,182,0,0.35)" : "linear-gradient(135deg, #FFB600, #FF6B00)",
              color: "#000", fontWeight: 800, fontSize: "15px",
              cursor: loading ? "not-allowed" : "pointer",
              boxShadow: loading ? "none" : "0 4px 24px rgba(255,182,0,0.25)",
            }}>
              {loading ? "Criando conta..." : "Criar conta e entrar →"}
            </button>
          </form>
        )}

        <p style={{ textAlign: "center", marginTop: "24px", fontSize: "12px", color: "#555" }}>
          Calculadora dos Sellers © {new Date().getFullYear()}
        </p>
      </div>

      {/* CSS para responsividade */}
      <style>{`
        @media (min-width: 900px) {
          .login-left { display: flex !important; }
          .login-mobile-logo { display: none !important; }
        }
      `}</style>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#0d0e12" }} />}>
      <LoginForm />
    </Suspense>
  );
}
