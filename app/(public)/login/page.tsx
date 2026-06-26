"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function Field({ label, value, onChange, type = "text", placeholder = "", required = false }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; required?: boolean;
}) {
  const inp: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: "10px", padding: "12px 16px", color: "#fff", fontSize: "15px", outline: "none",
  };
  return (
    <div>
      <label style={{ fontSize: "11px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.5px" }}>
        {label}{required && <span style={{ color: "#FFB600" }}> *</span>}
      </label>
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required} style={inp}
        onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.55)")}
        onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.1)")}
      />
    </div>
  );
}

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

  // Sem auto-redirect — deixa o usuário digitar livremente

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
    else if (res.status === 403 && data.naoVerificado) {
      router.push(`/verificar-email?email=${encodeURIComponent(email)}`);
    }
    else setErro(data.erro || "Email ou senha incorretos.");
  }

  async function handleCriar(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    if (!email || !senha || !nome) { setErro("Nome, email e senha são obrigatórios."); return; }
    setLoading(true);
    const resPerfil = await fetch("/api/perfil", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome_completo: nome, usuario, email, documento, senha, _novaConta: true }),
    });
    setLoading(false);
    if (!resPerfil.ok) {
      const d = await resPerfil.json().catch(() => ({}));
      setErro(d.mensagem || "Erro ao criar conta. Tente novamente.");
      return;
    }
    // Redireciona para página de verificação de email
    router.push(`/verificar-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0d0e12",
      backgroundImage: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(255,182,0,0.10) 0%, transparent 65%)",
    }}>
      <div style={{ width: "100%", maxWidth: "420px", padding: "0 24px" }}>

        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "52px", height: "52px", borderRadius: "14px",
            background: "linear-gradient(135deg, #FFB600, #FF6B00)",
            fontSize: "22px", fontWeight: 900, color: "#000", marginBottom: "14px",
          }}>C</div>
          <div style={{ fontSize: "20px", fontWeight: 900, color: "#fff" }}>Calculadora dos Sellers</div>
          <div style={{ fontSize: "13px", color: "#9099aa", marginTop: "4px" }}>
            {tab === "login" ? "Entre na sua conta" : "Crie sua conta gratuita"}
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "20px", padding: "32px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
        }}>
          {/* Tabs */}
          <div style={{
            display: "flex", background: "rgba(255,255,255,0.05)", borderRadius: "10px",
            padding: "4px", marginBottom: "28px",
          }}>
            {(["login", "criar"] as const).map(t => (
              <button key={t} onClick={() => { setTab(t); setErro(""); }} style={{
                flex: 1, padding: "9px", borderRadius: "8px", border: "none",
                background: tab === t ? "rgba(255,182,0,0.14)" : "transparent",
                color: tab === t ? "#FFB600" : "#9099aa",
                fontWeight: 700, fontSize: "13px", cursor: "pointer",
              }}>
                {t === "login" ? "Entrar" : "Criar conta"}
              </button>
            ))}
          </div>

          {/* Erro */}
          {erro && (
            <div style={{
              background: "rgba(255,80,80,0.08)", border: "1px solid rgba(255,80,80,0.25)",
              borderRadius: "8px", padding: "10px 14px", color: "#ff7777",
              fontSize: "13px", marginBottom: "20px",
            }}>{erro}</div>
          )}

          {/* Form Login */}
          {tab === "login" && (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="seu@email.com" required />
              <Field label="Senha" value={senha} onChange={setSenha} type="password" placeholder="••••••••" required />
              <button type="submit" disabled={loading} style={{
                marginTop: "4px", padding: "14px", borderRadius: "11px", border: "none",
                background: loading ? "rgba(255,182,0,0.35)" : "linear-gradient(135deg, #FFB600, #FF6B00)",
                color: "#000", fontWeight: 800, fontSize: "15px",
                cursor: loading ? "not-allowed" : "pointer",
                boxShadow: loading ? "none" : "0 6px 24px rgba(255,182,0,0.3)",
              }}>
                {loading ? "Entrando..." : "Entrar →"}
              </button>
            </form>
          )}

          {/* Form Criar */}
          {tab === "criar" && (
            <form onSubmit={handleCriar} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <Field label="Nome completo" value={nome} onChange={setNome} placeholder="Seu nome completo" required />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <Field label="Usuário" value={usuario} onChange={setUsuario} placeholder="@usuario" />
                <Field label="CPF / CNPJ" value={documento} onChange={setDocumento} placeholder="000.000.000-00" />
              </div>
              <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="seu@email.com" required />
              <Field label="Senha" value={senha} onChange={setSenha} type="password" placeholder="Mínimo 6 caracteres" required />
              <button type="submit" disabled={loading} style={{
                marginTop: "4px", padding: "14px", borderRadius: "11px", border: "none",
                background: loading ? "rgba(255,182,0,0.35)" : "linear-gradient(135deg, #FFB600, #FF6B00)",
                color: "#000", fontWeight: 800, fontSize: "15px",
                cursor: loading ? "not-allowed" : "pointer",
                boxShadow: loading ? "none" : "0 6px 24px rgba(255,182,0,0.3)",
              }}>
                {loading ? "Criando conta..." : "Criar conta e entrar →"}
              </button>
            </form>
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: "24px", fontSize: "12px", color: "#444" }}>
          Calculadora dos Sellers © {new Date().getFullYear()}
        </p>
      </div>
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
