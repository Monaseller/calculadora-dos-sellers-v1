"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import s from "../landing.module.css";

const NAV = ["Início","Recursos","Como funciona","Planos","Depoimentos","FAQ","Contato"];

export default function LandingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 60);
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);

  return (
    <header style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
      transition: "all 0.4s cubic-bezier(0.4,0,0.2,1)",
      background: scrolled ? "rgba(2,8,23,0.82)" : "transparent",
      backdropFilter: scrolled ? "blur(24px)" : "none",
      WebkitBackdropFilter: scrolled ? "blur(24px)" : "none",
      borderBottom: scrolled ? "1px solid rgba(255,255,255,0.06)" : "1px solid transparent",
    }}>
      <div style={{
        maxWidth: "1280px", margin: "0 auto",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        height: "72px", padding: "0 48px",
      }}>

        {/* Logo */}
        <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{
            width: "36px", height: "36px", borderRadius: "10px",
            background: "linear-gradient(135deg, #FF7A00, #FFB000)",
            display: "grid", placeItems: "center",
            fontSize: "17px", fontWeight: 900, color: "#020817",
          }}>C</div>
          <div>
            <div style={{ fontWeight: 800, fontSize: "14px", color: "#fff", lineHeight: 1.1 }}>CDS</div>
            <div style={{ fontSize: "8px", color: "#475569", letterSpacing: "1.2px", fontWeight: 600 }}>CALCULADORA DOS SELLERS</div>
          </div>
        </Link>

        {/* Nav links */}
        <nav className={s.navLinks} style={{ display: "flex", gap: "28px" }}>
          {NAV.map(item => (
            <a key={item} href={`#${item.toLowerCase().replace(/\s/g,"").replace("í","i").replace("ê","e").replace("ã","a")}`} className={s.navLink}>
              {item}
            </a>
          ))}
        </nav>

        {/* Actions */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <Link href="/login" className={s.btnSecondary} style={{
            padding: "9px 20px", borderRadius: "9px",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#CBD5E1", fontWeight: 600, fontSize: "14px", textDecoration: "none",
          }}>Entrar</Link>
          <Link href="/login" className={s.btnPrimary} style={{
            padding: "9px 20px", borderRadius: "9px",
            background: "linear-gradient(135deg, #FF7A00, #FFB000)",
            color: "#fff", fontWeight: 700, fontSize: "14px", textDecoration: "none",
            boxShadow: "0 4px 20px rgba(255,122,0,0.3)",
          }}>Testar grátis</Link>
        </div>
      </div>
    </header>
  );
}
