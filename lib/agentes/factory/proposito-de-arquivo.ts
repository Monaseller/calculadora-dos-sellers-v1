/**
 * O que este arquivo PARECE ser — AGENT-FACTORY-F7b.3.
 *
 * ── Sugestao, nunca decisao ─────────────────────────────────────────
 *
 * A Factory pergunta "o que este arquivo representa?" porque `papel` e o
 * campo que o MODELO le para distinguir uma planilha de entradas de uma
 * de saidas. Responder isso de cabeca, com vinte arquivos parecidos, e
 * onde a pessoa erra — e um `papel` errado nao e um rotulo feio, e uma
 * resposta errada.
 *
 * Este modulo olha o nome e os cabecalhos e OFERECE um palpite. Quem
 * decide continua sendo a pessoa: a tela pre-preenche o campo e ela
 * confirma ou reescreve.
 *
 * ── Deterministico, e de proposito ──────────────────────────────────
 *
 * Nenhuma chamada de IA. Tres motivos concretos:
 *
 *   1. Nao ha o que uma IA acerte aqui que uma regra nao acerte: o sinal
 *      esta no nome do arquivo e nos cabecalhos, que sao poucas palavras.
 *   2. Uma chamada de IA custa dinheiro e tempo num passo que acontece a
 *      cada upload.
 *   3. `BUSINESS_RULES` proibe numero financeiro vindo de IA. Isto nao
 *      produz numero, mas produz o ROTULO que o agente usa para escolher
 *      QUAL planilha somar — o que e a mesma autoridade, um passo antes.
 *
 * Sem sinal, devolve `null`. Um palpite inventado e pior que campo vazio:
 * a pessoa confirma sem ler.
 */

/** Um sinal: o rotulo sugerido e os termos que o disparam. */
interface Sinal {
  readonly papel: string;
  readonly termos: readonly string[];
}

/**
 * Os sinais, do mais especifico para o mais generico.
 *
 * A ordem importa: "contas a pagar" tem de vencer "contas", e "saida"
 * tem de ser testado antes de qualquer regra que casasse com "saldo".
 */
const SINAIS: readonly Sinal[] = Object.freeze([
  { papel: "Entradas", termos: ["entrada", "entradas", "receita", "receitas",
                                "recebimento", "recebimentos", "credito", "creditos",
                                "faturamento", "venda", "vendas"] },
  { papel: "Saídas", termos: ["saida", "saidas", "despesa", "despesas",
                              "pagamento", "pagamentos", "debito", "debitos",
                              "custo", "custos", "gasto", "gastos"] },
  { papel: "Estoque", termos: ["estoque", "inventario", "sku", "skus"] },
  { papel: "Pedidos", termos: ["pedido", "pedidos", "order", "orders"] },
  { papel: "Produtos", termos: ["produto", "produtos", "catalogo"] },
  { papel: "Clientes", termos: ["cliente", "clientes"] },
]);

/** Sem acento, sem caixa, sem pontuacao: `Saídas-2026.xlsx` -> `saidas 2026`. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface EntradaDaSugestao {
  readonly nome: string;
  /** Cabecalhos de TODAS as abas, achatados. Opcional. */
  readonly cabecalhos?: readonly string[];
}

/**
 * O papel sugerido, ou `null` quando nao ha sinal.
 *
 * O NOME do arquivo pesa mais que os cabecalhos, e a razao e pratica:
 * quem chama um arquivo de `entrada.xlsx` esta dizendo o que ele e.
 * Cabecalhos como "Valor" e "Data" aparecem nas duas planilhas e nao
 * distinguem nada — so entram quando o nome nao decide.
 */
export function sugerirPapel(entrada: EntradaDaSugestao): string | null {
  const doNome = normalizar(entrada.nome);
  // Compara por PALAVRA INTEIRA: sem isto, "saida" casaria dentro de
  // "assaida" e "venda" dentro de "vendaval".
  const palavrasDoNome = new Set(doNome.split(" ").filter((p) => p !== ""));
  for (const s of SINAIS) {
    if (s.termos.some((t) => palavrasDoNome.has(t))) return s.papel;
  }

  const heads = entrada.cabecalhos ?? [];
  if (heads.length === 0) return null;
  const palavrasDosHeads = new Set(
    heads.flatMap((h) => normalizar(h).split(" ")).filter((p) => p !== ""));
  for (const s of SINAIS) {
    if (s.termos.some((t) => palavrasDosHeads.has(t))) return s.papel;
  }

  return null;
}

/**
 * A frase que a tela mostra ao lado do campo.
 *
 * Deliberadamente diz "parece" e nomeia o motivo: uma sugestao que soa
 * como conclusao e confirmada sem ser lida.
 */
export function fraseDaSugestao(papel: string | null): string | null {
  if (papel === null) return null;
  return `Parece ser uma planilha de ${papel.toLowerCase()}. Confirme ou corrija.`;
}
