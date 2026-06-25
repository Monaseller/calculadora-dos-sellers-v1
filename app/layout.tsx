import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CDS — Calculadora dos Sellers",
  description: "Plataforma de gestão para sellers de marketplaces."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0 }}>
        {children}
      </body>
    </html>
  );
}