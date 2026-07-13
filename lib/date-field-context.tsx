"use client";
/**
 * date-field-context.tsx
 * Fase D (2026-07-06): seletor global "Data de Pagamento" / "Data de Criação".
 *
 * Fornece o estado `dateField` compartilhado entre todas as telas do app
 * (Dashboard, Vendas, KPIs, Gráficos, Balancete, Produtos, Rankings), persistido
 * em localStorage para manter a escolha do usuário entre navegações/reloads.
 * Padrão: "pagamento" (visão financeira), conforme decisão de arquitetura
 * registrada em docs/DECISIONS.md e docs/BUSINESS_RULES.md.
 *
 * Este contexto só guarda o valor selecionado — não faz nenhuma chamada de API.
 * Cada tela é responsável por ler `dateField` e repassar como parâmetro
 * `?date_field=` para /api/ml/vendas e /api/shopee/vendas (Fase C).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type DateField = "pagamento" | "criacao";

const STORAGE_KEY = "cds_date_field_v1";

interface DateFieldContextValue {
  dateField: DateField;
  setDateField: (value: DateField) => void;
}

const DateFieldContext = createContext<DateFieldContextValue>({
  dateField: "pagamento",
  setDateField: () => {},
});

export function DateFieldProvider({ children }: { children: ReactNode }) {
  const [dateField, setDateFieldState] = useState<DateField>("pagamento");

  // Restaura a escolha salva (client-only — localStorage não existe no SSR)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "pagamento" || saved === "criacao") setDateFieldState(saved);
    } catch {
      // localStorage indisponível (modo privado, etc.) — mantém o padrão "pagamento"
    }
  }, []);

  function setDateField(value: DateField) {
    setDateFieldState(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // silencioso — persistência é um bônus, não deve quebrar a troca de visão
    }
  }

  return (
    <DateFieldContext.Provider value={{ dateField, setDateField }}>
      {children}
    </DateFieldContext.Provider>
  );
}

export function useDateField(): DateFieldContextValue {
  return useContext(DateFieldContext);
}
