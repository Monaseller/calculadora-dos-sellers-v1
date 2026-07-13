import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";
import { DateFieldProvider } from "@/lib/date-field-context";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    // Fase D (2026-07-06): DateFieldProvider global — o seletor Data de Pagamento/Criação
    // (renderizado na TopBar) precisa estar disponível para todas as páginas de (app).
    <DateFieldProvider>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar />
        <div style={{ marginLeft: "240px", flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <TopBar />
          <main style={{ flex: 1 }}>
            {children}
          </main>
        </div>
      </div>
    </DateFieldProvider>
  );
}
