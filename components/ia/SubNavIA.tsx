"use client";

/**
 * Subnavegacao da CDS IA — as 6 areas.
 *
 * ── Por que uma subnav, e nao 6 itens na Sidebar ────────────────────
 *
 * A Sidebar e a navegacao do CDS inteiro e nao tem agrupamento: seis
 * itens novos ali diluiriam as nove telas existentes. A CDS IA entra
 * como UM item, e a navegacao interna dela vive aqui — o mesmo padrao
 * que o Estudio de Anuncios ja usa ao viver sob `/central-ia`.
 *
 * ── O criterio de "ativo" ───────────────────────────────────────────
 *
 * Copiado da Sidebar (`path === href || path.startsWith(href + "/")`)
 * por consistencia, com uma correcao necessaria: `/ia` e prefixo de
 * TODAS as outras rotas da area, entao com a regra crua ele ficaria
 * eternamente ativo. Escritorio casa por igualdade exata.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { MOCK_CONTAGENS } from "@/lib/ia/mocks";

interface ItemNav {
  href: string;
  rotulo: string;
  /** `true` = so casa por igualdade. Ver cabecalho. */
  exato?: boolean;
  contador?: number;
  /** Texto lido por leitor de tela no lugar do numero solto. */
  descricaoContador?: string;
}

export const AREAS_CDS_IA: readonly ItemNav[] = [
  {
    href: "/ia",
    rotulo: "Escritório",
    exato: true,
    contador: MOCK_CONTAGENS.trabalhando,
    descricaoContador: "agentes trabalhando",
  },
  { href: "/ia/agentes", rotulo: "Agentes" },
  { href: "/ia/conexoes", rotulo: "Conexões" },
  {
    href: "/ia/aprovacoes",
    rotulo: "Aprovações",
    contador: MOCK_CONTAGENS.aguardandoAprovacao,
    descricaoContador: "aprovações pendentes",
  },
  { href: "/ia/atividade", rotulo: "Atividade" },
  { href: "/ia/custos", rotulo: "Custos" },
];

export default function SubNavIA() {
  const caminho = usePathname() ?? "";

  return (
    <nav aria-label="Áreas da CDS IA" style={{ borderBottom: `1px solid ${CROMO.bordaSutil}` }}>
      <ul
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: ESPACO.xs,
          listStyle: "none",
          margin: 0,
          padding: 0,
        }}
      >
        {AREAS_CDS_IA.map((item) => {
          const ativo = item.exato
            ? caminho === item.href
            : caminho === item.href || caminho.startsWith(item.href + "/");

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={ativo ? "page" : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: ESPACO.sm,
                  padding: "10px 14px",
                  borderRadius: `${RAIO.controle}px ${RAIO.controle}px 0 0`,
                  textDecoration: "none",
                  font: `${ativo ? 700 : 500} 13px/1 ${FONTE.interface}`,
                  color: ativo ? CROMO.acento : CROMO.textoFraco,
                  background: ativo ? CROMO.acentoFundo : "transparent",
                  // Sublinhado do item ativo: `aria-current` cobre o
                  // leitor de tela, mas quem enxerga precisa de algo
                  // alem da cor.
                  boxShadow: ativo ? `inset 0 -2px 0 0 ${CROMO.acento}` : "none",
                }}
              >
                {item.rotulo}
                {item.contador !== undefined && item.contador > 0 && (
                  <span
                    style={{
                      display: "inline-grid",
                      placeItems: "center",
                      minWidth: 18,
                      height: 18,
                      padding: "0 5px",
                      borderRadius: 999,
                      background: CROMO.acento,
                      color: "#1a1005",
                      font: `700 11px/1 ${FONTE.interface}`,
                    }}
                  >
                    <span aria-hidden="true">{item.contador}</span>
                    <span
                      style={{
                        position: "absolute",
                        width: 1,
                        height: 1,
                        overflow: "hidden",
                        clip: "rect(0 0 0 0)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.contador} {item.descricaoContador}
                    </span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
