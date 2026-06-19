import "./globals.css";
import type { Metadata } from "next";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

export const metadata: Metadata = {
  title: "CDS — Calculadora dos Sellers",
  description: "Plataforma de gestão para sellers de marketplaces."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0 }}>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <Sidebar />
          <div style={{ marginLeft: "240px", flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            <TopBar />
            <main style={{ flex: 1 }}>
              {children}
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}