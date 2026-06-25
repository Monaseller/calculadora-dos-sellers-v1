"use client";
import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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

  // Se já tem sessão, redireciona
  useEffect(() => {
    fetch("/api/auth/status-session")
      .then(r => r.ok && router.replace(redirect))
      .catch(() => {});
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    setLoading(true);

    const res = await fetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, senha }),
    });

    setLoading(false);

    if (res.ok) {
      router.replace(redirect);
    } else {
      const data = await res.json();
      // Se não tem conta, vai para criar
      if (res.status === 404) {
        setTab("criar");
        setEmail(email);
        setErro("Nenhuma conta encontrada. Crie sua conta abaixo.");
      } else {
        setErro(data.erro || "Erro ao fazer login.");
      }
    }
  }

  async function handleCriar(e: React.FormEvent) {
    e.preventDefault();
    setErro("");
    if (!email || !senha || !nome) {
      setErro("Nome, email e senha são obrigatórios.");
      return;
    }
    setLoading(true);

    // Salva perfil
    const resPerfil = await fetch("/api/perfil", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ nome_completo: nome, usuario, email, documento, senha }),
    });

    if (!resPerfil.ok) {
      setLoading(false);
      setErro("Erro ao criar conta.");
      return;
    }

    // Loga automaticamente
    const resLogin = await fetch("/api/auth/login", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email, senha }),
    });

    setLoading(false);

    if (resLogin.ok) {
      router.replace(redirect);
    } else {
      setErro("Conta criada! Faça login.");
      setTab("login");
    }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", boxSizing: "border-box",
    background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "10px", padding: "12px 16px", color: "#fff", fontSize: "15px",
    outline: "none",
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0d0e12",
      backgroundImage: "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(255,182,0,0.12) 0%, transparent 60%)",
    }}>
      <div style={{
        width: "100%", maxWidth: "420px", padding: "0 20px",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "36px" }}>
          <div style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: "52px", height: "52px", borderRadius: "14px",
            background: "linear-gradient(135deg, #FFB600, #FF6B00)",
            fontSize: "22px", fontWeight: 900, color: "#000",
            marginBottom: "16px",
          }}>
            C
          </div>
          <div style={{ fontSize: "22px", fontWeight: 900, color: "#fff" }}>
            Calculadora dos Sellers
          </div>
          <div style={{ fontSize: "13px", color: "#9099aa", marginTop: "4px" }}>
            {tab === "login" ? "Entre na sua conta" : "Crie sua conta"}
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.09)",
          borderRadius: "18px", padding: "32px",
        }}>
          {/* Tabs */}
          <div style={{
            display: "flex", background: "rgba(255,255,255,0.05)", borderRadius: "10px",
            padding: "4px", marginBottom: "28px",
          }}>
            {(["login", "criar"] as const).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setErro(""); }}
                style={{
                  flex: 1, padding: "8px", borderRadius: "8px", border: "none",
                  background: tab === t ? "rgba(255,182,0,0.15)" : "transparent",
                  color: tab === t ? "#FFB600" : "#9099aa",
                  fontWeight: 700, fontSize: "13px", cursor: "pointer",
                  borderBottom: tab === t ? "2px solid #FFB600" : "2px solid transparent",
                }}
              >
                {t === "login" ? "Entrar" : "Criar conta"}
              </button>
            ))}
          </div>

          {/* Erro */}
          {erro && (
            <div style={{
              background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.3)",
              borderRadius: "8px", padding: "10px 14px", color: "#ff7070",
              fontSize: "13px", marginBottom: "20px",
            }}>
              {erro}
            </div>
          )}

          {/* Form Login */}
          {tab === "login" && (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                  EMAIL
                </label>
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="seu@email.com" required style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                  SENHA
                </label>
                <input
                  type="password" value={senha} onChange={e => setSenha(e.target.value)}
                  placeholder="••••••••" required style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>
              <button
                type="submit" disabled={loading}
                style={{
                  marginTop: "8px", padding: "13px", borderRadius: "10px", border: "none",
                  background: loading ? "rgba(255,182,0,0.4)" : "rgba(255,182,0,0.9)",
                  color: "#000", fontWeight: 800, fontSize: "15px",
                  cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Entrando..." : "Entrar"}
              </button>
            </form>
          )}

          {/* Form Criar */}
          {tab === "criar" && (
            <form onSubmit={handleCriar} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                  NOME COMPLETO *
                </label>
                <input
                  type="text" value={nome} onChange={e => setNome(e.target.value)}
                  placeholder="Seu nome completo" required style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                    USUÁRIO
                  </label>
                  <input
                    type="text" value={usuario} onChange={e => setUsuario(e.target.value)}
                    placeholder="@usuario" style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                    onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                    CPF / CNPJ
                  </label>
                  <input
                    type="text" value={documento} onChange={e => setDocumento(e.target.value)}
                    placeholder="000.000.000-00" style={inputStyle}
                    onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                    onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                  />
                </div>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                  EMAIL *
                </label>
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="seu@email.com" required style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 700, color: "#9099aa", display: "block", marginBottom: "6px" }}>
                  SENHA *
                </label>
                <input
                  type="password" value={senha} onChange={e => setSenha(e.target.value)}
                  placeholder="Mínimo 6 caracteres" required style={inputStyle}
                  onFocus={e => (e.target.style.borderColor = "rgba(255,182,0,0.5)")}
                  onBlur={e  => (e.target.style.borderColor = "rgba(255,255,255,0.12)")}
                />
              </div>
              <button
                type="submit" disabled={loading}
                style={{
                  marginTop: "8px", padding: "13px", borderRadius: "10px", border: "none",
                  background: loading ? "rgba(255,182,0,0.4)" : "rgba(255,182,0,0.9)",
                  color: "#000", fontWeight: 800, fontSize: "15px",
                  cursor: loading ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Criando conta..." : "Criar conta e entrar"}
              </button>
            </form>
          )}
        </div>

        <div style={{ textAlign: "center", marginTop: "20px", fontSize: "12px", color: "#555" }}>
          Calculadora dos Sellers © {new Date().getFullYear()}
        </div>
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
