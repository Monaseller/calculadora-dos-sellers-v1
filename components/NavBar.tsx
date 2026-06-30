"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/",         label: "Calculadora" },
  { href: "/anuncios", label: "Meus Anúncios" },
];

export default function NavBar() {
  const path = usePathname();

  return (
    <nav style={{
      position: "sticky",
      top: 0,
      zIndex: 50,
      background: "rgba(7,9,15,0.92)",
      backdropFilter: "blur(12px)",
      borderBottom: "1px solid rgba(255,255,255,0.08)",
      padding: "0 24px",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      height: "56px",
    }}>
      {/* Logo */}
      <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", marginRight: "24px" }}>
        <img src="/logo-cds.png" alt="Calculadora dos Sellers" style={{ height: "40px", width: "auto", objectFit: "contain" }} />
      </Link>

      {/* Links */}
      {links.map(({ href, label }) => {
        const active = path === href;
        return (
          <Link key={href} href={href} style={{
            textDecoration: "none",
            padding: "7px 16px",
            borderRadius: "10px",
            fontWeight: 700,
            fontSize: "14px",
            color: active ? "#ffb800" : "#9099aa",
            background: active ? "rgba(255,184,0,0.12)" : "transparent",
            border: active ? "1px solid rgba(255,184,0,0.25)" : "1px solid transparent",
            transition: "all 0.15s",
          }}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
