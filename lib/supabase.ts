import { createClient } from "@supabase/supabase-js";

const url  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(url, key);

// ── Tipos ──────────────────────────────────────────────────────────────────

export type Marketplace = "ML" | "Shopee";

export interface Anuncio {
  id: string;
  created_at: string;
  nome: string;
  marketplace: Marketplace;
  categoria: string | null;
  tipo_anuncio: string | null;        // ML: "Clássico" | "Premium"
  tipo_conta_shopee: string | null;   // Shopee: "CNPJ" | "CPF"
  custo_produto: number;
  insumos: number;
  custo_frete: number;
  frete_gratis: boolean;
  imposto: number;
  margem_desejada: number;
  preco_ideal: number | null;
  preco_anuncio: number | null;
  ml_item_id: string | null;
  thumbnail: string | null;
  permalink: string | null;
  ativo: boolean;
  // Campos novos
  sku: string | null;
  lucro_liquido: number | null;
  margem_contribuicao: number | null;
  peso_kg: number | null;
  variation_id: string | null;
  logistic_type: string | null;  // ML: 'fulfillment' | 'self_service' | 'me2' | 'cross_docking'
  user_id: string | null;
}

export interface VendaDia {
  id: string;
  created_at: string;
  anuncio_id: string;
  data: string;
  unidades_vendidas: number;
  faturamento: number;
  lucro: number;
}
