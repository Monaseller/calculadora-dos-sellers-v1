export type TipoAnuncio = "Clássico" | "Premium";

export interface Categoria {
  nome: string;
  classico: number; // decimal — ex: 0.13 = 13%
  premium: number;
}

/**
 * Todas as categorias principais do Mercado Livre Brasil (2026)
 * Taxas: Clássico 11–14% | Premium 16–19%
 * Fonte: ML Central do Vendedor + gestorshop.com.br/blog/comissoes-mercado-livre-2026-tabela
 */
export const CATEGORIAS_ML: Categoria[] = [
  { nome: "Acessórios para Veículos",        classico: 0.11, premium: 0.16 },
  { nome: "Agro",                             classico: 0.11, premium: 0.16 },
  { nome: "Alimentos e Bebidas",              classico: 0.12, premium: 0.17 },
  { nome: "Animais",                          classico: 0.12, premium: 0.17 },
  { nome: "Arte, Papelaria e Armarinho",      classico: 0.12, premium: 0.17 },
  { nome: "Bebês",                            classico: 0.13, premium: 0.18 },
  { nome: "Beleza e Cuidados Pessoais",       classico: 0.13, premium: 0.18 },
  { nome: "Brinquedos e Hobbies",             classico: 0.13, premium: 0.18 },
  { nome: "Calçados, Roupas e Bolsas",        classico: 0.14, premium: 0.19 },
  { nome: "Casa, Móveis e Decoração",         classico: 0.13, premium: 0.18 },
  { nome: "Celulares e Telefones",            classico: 0.11, premium: 0.16 },
  { nome: "Construção",                       classico: 0.12, premium: 0.17 },
  { nome: "Eletrodomésticos",                 classico: 0.12, premium: 0.17 },
  { nome: "Eletrônicos, Áudio e Vídeo",       classico: 0.12, premium: 0.17 },
  { nome: "Esporte e Lazer",                  classico: 0.13, premium: 0.18 },
  { nome: "Ferramentas",                      classico: 0.12, premium: 0.17 },
  { nome: "Indústria e Comércio",             classico: 0.11, premium: 0.16 },
  { nome: "Informática",                      classico: 0.12, premium: 0.17 },
  { nome: "Instrumentos Musicais",            classico: 0.12, premium: 0.17 },
  { nome: "Joias e Relógios",                 classico: 0.14, premium: 0.19 },
  { nome: "Livros, Revistas e Comics",        classico: 0.11, premium: 0.16 },
  { nome: "Música, Filmes e Seriados",        classico: 0.11, premium: 0.16 },
  { nome: "Peças para Veículos",              classico: 0.11, premium: 0.16 },
  { nome: "Saúde",                            classico: 0.13, premium: 0.18 },
];

/**
 * Taxa fixa por faixa de preço — Mercado Livre 2026
 * Fonte: ML Central do Vendedor / koncili.com/blog/categorias-do-mercado-livre
 *
 * Produtos gerais:
 *   Até R$ 12,50        → 50% do valor do produto
 *   R$ 12,50 – R$ 29    → R$ 6,25
 *   R$ 29,01 – R$ 50    → R$ 6,50
 *   R$ 50,01 – R$ 78,99 → R$ 6,75
 *   R$ 79+              → R$ 0,00 (frete grátis obrigatório)
 *
 * Nota: Livros e Supermercado têm tabelas próprias diferentes.
 */
export function calcularTaxaFixa(preco: number): number {
  if (preco >= 79) return 0;
  if (preco > 50) return 6.75;
  if (preco > 29) return 6.50;
  if (preco >= 12.50) return 6.25;
  return preco / 2; // até R$ 12,50: 50% do valor
}

/**
 * Calcula o valor líquido e o detalhamento das deduções do ML.
 *
 * @param custoFrete - Valor real do custo de envio informado pelo seller (do painel ML).
 *                     Desde março/2026, o Full não tem mais taxa fixa — o custo de envio
 *                     é variável por peso/dimensão. Use calcularTaxaFixa() apenas como
 *                     estimativa quando o seller não informar o valor real.
 */
export function calcularValorLiquido(
  preco: number,
  categoriaNome: string,
  tipoAnuncio: TipoAnuncio,
  custoFrete: number
): {
  valorLiquido: number;
  comissaoPercentual: number;
  comissaoValor: number;
  custoFrete: number;
} {
  const cat = CATEGORIAS_ML.find((c) => c.nome === categoriaNome);
  const comissaoPercentual = cat
    ? tipoAnuncio === "Premium" ? cat.premium : cat.classico
    : tipoAnuncio === "Premium" ? 0.18 : 0.13;

  const comissaoValor = preco * comissaoPercentual;
  const valorLiquido = preco - comissaoValor - custoFrete;

  return { valorLiquido, comissaoPercentual, comissaoValor, custoFrete };
}

// Compatibilidade com chamadas legadas que usam categoriaId (retornado pela API ML)
const comissoesPorCategoriaId: Record<string, { classico: number; premium: number }> = {
  MLB257279: { classico: 0.13, premium: 0.18 }, // Pinças
  MLB194235: { classico: 0.13, premium: 0.18 }, // Extensão de cílios
};

export function obterComissaoMercadoLivre(categoriaId: string, tipoAnuncio: TipoAnuncio) {
  const regra = comissoesPorCategoriaId[categoriaId];
  if (!regra) return tipoAnuncio === "Premium" ? 0.18 : 0.13;
  return tipoAnuncio === "Premium" ? regra.premium : regra.classico;
}
