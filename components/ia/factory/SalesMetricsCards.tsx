/**
 * Os 4 KPIs de vendas do Mercado Livre — F8.1-B4B.
 *
 * ── Este componente APRESENTA, nunca calcula ────────────────────────
 *
 * Recebe `ApresentacaoDoPassoUI` ja validada pelo transporte
 * (`lib/ia/agentes-http.ts`), que por sua vez veio do runtime do
 * Mercado Livre sem recalculo. Aqui so ha FORMATACAO: moeda BRL, inteiro
 * pt-BR e data AAAA-MM-DD -> DD/MM/AAAA. Nenhuma conta sobre os valores:
 * o ticket medio exibido e o `ticketMedio` recebido, e nao uma divisao.
 *
 * Ele nao conhece Tool, API, banco nem o texto do agente. Os rotulos
 * ("Vendas brutas", ...) sao so rotulos: nada e lido do Markdown.
 *
 * ── Ativacao puramente visual ───────────────────────────────────────
 *
 * Nasce oculto (`--cds-chat-kpis-display`, fallback `none`): o Workspace
 * e o Wizard nao mudam. O host do Office V1 define a variavel e os cards
 * aparecem — o mesmo mecanismo de `--cds-chat-*` do F8.1-B3, sem prop
 * nova no `ChatDoAgente`.
 */
// O namespace entra pelo mesmo motivo de `TextoDoAgente`: `jsx:
// "preserve"` deixa o Next transformar, mas a suite roda o componente
// com `tsx`, que usa o runtime classico e precisa de `React` em escopo.
import * as React from "react";
import type { CSSProperties } from "react";
import type { ApresentacaoDoPassoUI, PassoDoChatUI } from "@/lib/ia/agentes-http";
import { CORES_DASHBOARD, estiloDeCard, type CorDeDashboard } from "@/lib/ia/cores-dashboard";

/** Uma apresentacao `vendas_ml` — o unico tipo que estes cards desenham. */
export type ApresentacaoVendasML = Extract<ApresentacaoDoPassoUI, { tipo: "vendas_ml" }>;

/**
 * As apresentacoes `vendas_ml` DAQUELA mensagem, na ordem dos passos.
 *
 * Cada uma vira um conjunto proprio de cards: nada e somado nem
 * misturado entre passos. Duplicatas EXATAS (o mesmo resultado
 * registrado duas vezes) aparecem uma vez so — repetir o mesmo conjunto
 * seria ruido, e nao informacao.
 */
export function apresentacoesDeVendasML(
  passos: readonly PassoDoChatUI[]
): readonly ApresentacaoVendasML[] {
  const vistas = new Set<string>();
  const lista: ApresentacaoVendasML[] = [];
  for (const p of passos) {
    const a = p.apresentacao;
    if (a === null || a.tipo !== "vendas_ml") continue;
    // Chave composta (sem serializar): os 7 campos do contrato, rotulados;
    // datas por `encodeURIComponent` (injetivo) — sem colisao por separador.
    const chave = `tipo=${a.tipo}|valor=${a.valor}|vendas=${a.vendas}|unidades=${a.unidades}` +
      `|ticketMedio=${a.ticketMedio}|de=${encodeURIComponent(a.periodo.de)}|ate=${encodeURIComponent(a.periodo.ate)}`;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    lista.push(a);
  }
  return lista;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
// Sem `maximumFractionDigits`: forcar 0 arredondaria um valor que nao
// fosse inteiro, e arredondar ja seria decidir algo sobre o numero.
const NUMERO = new Intl.NumberFormat("pt-BR");

/**
 * AAAA-MM-DD -> DD/MM/AAAA por particao da string, sem `Date`: a data ja
 * vem resolvida no fuso da CDS, e passar por `Date` poderia desloca-la um
 * dia. Formato inesperado aparece como veio.
 */
export function dataPtBR(iso: string): string {
  const partes = iso.split("-");
  if (partes.length !== 3) return iso;
  const [ano, mes, dia] = partes;
  const digitos = (s: string, n: number) =>
    s.length === n && [...s].every((c) => c >= "0" && c <= "9");
  if (!digitos(ano, 4) || !digitos(mes, 2) || !digitos(dia, 2)) return iso;
  return `${dia}/${mes}/${ano}`;
}

const estilos: Record<string, CSSProperties> = {
  raiz: {
    display: "var(--cds-chat-kpis-display, none)",
    marginTop: 12,
  },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 8,
    margin: 0,
  },
  card: {
    minWidth: 0,
    padding: "10px 12px",
    borderRadius: 10,
    background: "var(--cds-chat-kpi-fundo, rgba(255,255,255,0.03))",
    border: "var(--cds-chat-kpi-borda, 1px solid rgba(255,255,255,0.08))",
  },
  rotulo: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    margin: 0,
    fontSize: 12,
    lineHeight: 1.3,
    color: "var(--cds-chat-kpi-rotulo, #98a2b3)",
  },
  valor: {
    margin: "4px 0 0",
    fontSize: 19,
    fontWeight: 700,
    lineHeight: 1.2,
    color: "var(--cds-chat-kpi-valor, #eef1f6)",
    fontVariantNumeric: "tabular-nums",
    overflowWrap: "anywhere",
  },
  periodo: {
    margin: "8px 0 0",
    fontSize: 12,
    color: "var(--cds-chat-kpi-rotulo, #98a2b3)",
  },
};

export default function SalesMetricsCards({
  apresentacao,
}: {
  apresentacao: ApresentacaoVendasML;
}) {
  // F8.1-C1: a cor e IDENTIDADE do card (regra em `cores-dashboard.ts`).
  // So apresentacao: valores, ordem e origem nao mudam.
  const kpis: readonly { rotulo: string; valor: string; cor: CorDeDashboard }[] = [
    { rotulo: "Vendas brutas", valor: BRL.format(apresentacao.valor), cor: CORES_DASHBOARD.laranja },
    { rotulo: "Vendas (pedidos)", valor: NUMERO.format(apresentacao.vendas), cor: CORES_DASHBOARD.azul },
    { rotulo: "Unidades (itens)", valor: NUMERO.format(apresentacao.unidades), cor: CORES_DASHBOARD.violeta },
    { rotulo: "Ticket médio", valor: BRL.format(apresentacao.ticketMedio), cor: CORES_DASHBOARD.verde },
  ];

  return (
    <section aria-label="Resumo de vendas do Mercado Livre" style={estilos.raiz}>
      <dl style={estilos.grade}>
        {kpis.map((k) => {
          const c = estiloDeCard(k.cor);
          return (
            <div
              key={k.rotulo}
              data-kpi={k.rotulo}
              style={{
                ...estilos.card,
                border: c.borda,
                // O glow da cor POR CIMA do fundo escuro de sempre.
                background: `${c.fundo}, var(--cds-chat-kpi-fundo, rgba(255,255,255,0.03))`,
              }}
            >
              <dt style={estilos.rotulo}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 7, height: 7, flexShrink: 0, borderRadius: 999,
                    background: c.indicador, boxShadow: `0 0 6px ${c.indicador}`,
                  }}
                />
                {k.rotulo}
              </dt>
              <dd style={{ ...estilos.valor, color: c.numero }}>{k.valor}</dd>
            </div>
          );
        })}
      </dl>
      <p style={estilos.periodo}>
        Período: {dataPtBR(apresentacao.periodo.de)} a {dataPtBR(apresentacao.periodo.ate)}
      </p>
    </section>
  );
}
