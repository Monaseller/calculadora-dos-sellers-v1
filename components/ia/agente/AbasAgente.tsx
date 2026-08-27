"use client";

/**
 * Navegacao entre as 8 abas do agente.
 *
 * ── Por que NAO usamos role="tablist" ───────────────────────────────
 *
 * O padrao ARIA de tabs pressupoe paineis que trocam SEM sair da pagina,
 * com setas do teclado movendo a selecao e Tab saindo do conjunto. Aqui
 * cada aba e uma URL: sao LINKS de navegacao, e o navegador ja da a eles
 * teclado, foco, menu de contexto, abrir em nova aba e historico.
 *
 * Marcar links de navegacao como `role="tab"` mentiria para o leitor de
 * tela — ele anunciaria "aba" e prometeria comportamento de setas que os
 * links nao tem — e ainda quebraria "abrir em nova aba", que e
 * comportamento legitimo de link. A recomendacao da propria APG e nao
 * usar o padrao de tabs quando a selecao muda a URL.
 *
 * Entao: `<nav>` + lista de `<a>`, com `aria-current="page"` marcando a
 * ativa. Menos ARIA e mais semantica nativa.
 *
 * ── Rolagem horizontal no mobile ────────────────────────────────────
 *
 * `overflow-x: auto` com `scroll-snap`, por CSS. Sem medir viewport, sem
 * listener, sem menu "mais" em JavaScript.
 */
import Link from "next/link";
import { ABAS, type AbaId } from "@/lib/ia/abas";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";

export default function AbasAgente({
  agenteId,
  ativa,
}: {
  agenteId: string;
  ativa: AbaId;
}) {
  return (
    <>
      <style>{css}</style>
      <nav aria-label="Seções do agente" className="cds-ia-abas">
        <ul className="cds-ia-abas-lista">
          {ABAS.map((aba) => {
            const selecionada = aba.id === ativa;
            return (
              <li key={aba.id} className="cds-ia-aba-item">
                <Link
                  href={`/ia/agentes/${agenteId}?aba=${aba.id}`}
                  aria-current={selecionada ? "page" : undefined}
                  className={selecionada ? "cds-ia-aba cds-ia-aba-ativa" : "cds-ia-aba"}
                >
                  {aba.rotulo}
                  {/* Ponto: sinaliza "ainda nao construida" sem depender
                      de cor, e com texto so para leitor de tela. */}
                  {!aba.implementada && (
                    <>
                      <span aria-hidden="true" className="cds-ia-aba-ponto">
                        •
                      </span>
                      <span className="cds-ia-oculto">(em breve)</span>
                    </>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

const css = `
  .cds-ia-abas {
    border-bottom: 1px solid ${CROMO.bordaSutil};
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
  }
  .cds-ia-abas-lista {
    display: flex;
    gap: ${ESPACO.xs}px;
    margin: 0;
    padding: 0;
    list-style: none;
    scroll-snap-type: x proximity;
  }
  .cds-ia-aba-item { scroll-snap-align: start; }
  .cds-ia-aba {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    white-space: nowrap;
    text-decoration: none;
    border-radius: ${RAIO.controle}px ${RAIO.controle}px 0 0;
    font: 500 13px/1 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-ia-aba:hover { color: ${CROMO.texto}; background: ${CROMO.fundoCard}; }
  .cds-ia-aba:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: -2px; }
  .cds-ia-aba-ativa {
    color: ${CROMO.acento};
    background: ${CROMO.acentoFundo};
    font-weight: 700;
    /* Sublinhado, e nao so cor: aria-current cobre o leitor de tela,
       isto cobre quem enxerga sem distinguir a cor. */
    box-shadow: inset 0 -2px 0 0 ${CROMO.acento};
  }
  .cds-ia-aba-ponto { font-size: 16px; line-height: 0; opacity: .5; }
  .cds-ia-oculto {
    position: absolute;
    width: 1px; height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
`;
