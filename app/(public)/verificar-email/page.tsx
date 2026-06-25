"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

function VerificarEmailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get("token");
  const email = searchParams.get("email");

  const [status, setStatus] = useState<"verificando" | "ok" | "erro" | "aguardando" | "reenviando" | "reenviado">(
    token ? "verificando" : "aguardando"
  );
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (!token) return;
    fetch(`/api/auth/verificar-email?token=${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) setStatus("ok");
        else { setStatus("erro"); setErro(data.erro || "Token inválido."); }
      })
      .catch(() => { setStatus("erro"); setErro("Erro ao verificar. Tente novamente."); });
  }, [token]);

  async function reenviar() {
    if (!email) return;
    setStatus("reenviando");
    const res = await fetch("/api/auth/verificar-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (res.ok) setStatus("reenviado");
    else setStatus("aguardando");
  }

  const card = (icon: string, titulo: string, desc: string, botao?: { label: string; onClick?: () => void; href?: string }) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: "56px", marginBottom: "24px" }}>{icon}</div>
      <h1 style={{ fontSize: "26px", fontWeight: 900, color: "#fff", margin: "0 0 12px 0" }}>{titulo}</h1>
      <p style={{ fontSize: "15px", color: "#9099aa", lineHeight: 1.6, margin: "0 0 32px 0" }}>{desc}</p>
      {botao && (
        botao.href ? (
          <Link href={botao.href} style={{ display: "inline-block", padding: "14px 32px", borderRadius: "11px", background: "linear-gradient(135deg,#FFB600,#FF6B00)", color: "#000", fontWeight: 800, fontSize: "15px", textDecoration: "none" }}>
            {botao.label}
          </Link>
        ) : (
          <button onClick={botao.onClick} style={{ padding: "14px 32px", borderRadius: "11px", background: "linear-gradient(135deg,#FFB600,#FF6B00)", color: "#000", fontWeight: 800, fontSize: "15px", border: "none", cursor: "pointer" }}>
            {botao.label}
          </button>
        )
      )}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#0d0e12", backgroundImage: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(255,182,0,0.10) 0%, transparent 65%)", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
      <div style={{ width: "100%", maxWidth: "460px" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "52px", height: "52px", borderRadius: "14px", background: "linear-gradient(135deg,#FFB600,#FF6B00)", fontSize: "22px", fontWeight: 900, color: "#000" }}>C</div>
        </div>

        <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "20px", padding: "48px 36px", boxShadow: "0 24px 64px rgba(0,0,0,0.4)" }}>
          {status === "verificando" && card("⏳", "Verificando...", "Aguarde enquanto confirmamos seu email.")}

          {status === "ok" && card(
            "✅",
            "Email confirmado!",
            "Seu email foi verificado com sucesso. Agora você pode fazer o login.",
            { label: "Fazer login →", href: "/login" }
          )}

          {status === "erro" && card(
            "❌",
            "Link inválido",
            erro || "Este link é inválido ou já expirou.",
            email ? { label: "Reenviar email", onClick: reenviar } : undefined
          )}

          {status === "aguardando" && (
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "56px", marginBottom: "24px" }}>📧</div>
              <h1 style={{ fontSize: "26px", fontWeight: 900, color: "#fff", margin: "0 0 12px 0" }}>Confirme seu email</h1>
              <p style={{ fontSize: "15px", color: "#9099aa", lineHeight: 1.6, margin: "0 0 8px 0" }}>
                Enviamos um link de confirmação para:
              </p>
              <p style={{ fontSize: "16px", fontWeight: 700, color: "#FFB600", margin: "0 0 32px 0" }}>{email || "seu email"}</p>
              <p style={{ fontSize: "13px", color: "#555", marginBottom: "24px" }}>Não recebeu? Verifique a pasta de spam.</p>
              {email && (
                <button onClick={reenviar} style={{ padding: "12px 28px", borderRadius: "10px", background: "rgba(255,182,0,0.1)", border: "1px solid rgba(255,182,0,0.3)", color: "#FFB600", fontWeight: 700, fontSize: "14px", cursor: "pointer" }}>
                  Reenviar email
                </button>
              )}
            </div>
          )}

          {status === "reenviando" && card("⏳", "Reenviando...", "Aguarde um momento.")}

          {status === "reenviado" && card(
            "📬",
            "Email reenviado!",
            "Verifique sua caixa de entrada e clique no link de confirmação.",
          )}
        </div>

        <p style={{ textAlign: "center", marginTop: "24px", fontSize: "12px", color: "#444" }}>
          <Link href="/login" style={{ color: "#9099aa", textDecoration: "none" }}>← Voltar para o login</Link>
        </p>
      </div>
    </div>
  );
}

export default function VerificarEmailPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#0d0e12" }} />}>
      <VerificarEmailContent />
    </Suspense>
  );
}
