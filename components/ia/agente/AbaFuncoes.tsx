"use client";

/**
 * Aba Funcoes do agente.
 *
 * ── A legenda nao e enfeite ─────────────────────────────────────────
 *
 * "Disponível" e "Permitida" sao a mesma cara de selo em telas
 * parecidas do mercado, e a confusao entre as duas e o erro que faria
 * alguem acreditar que o agente pode fazer algo que ele nao pode. A
 * legenda no topo existe para ensinar a diferenca uma vez, antes dos
 * cards.
 *
 * ── Ordem deliberada ────────────────────────────────────────────────
 *
 * Funcoes que o sistema JA sabe fazer vem primeiro. O que existe deve
 * ser encontrado antes do que ainda nao existe — caso contrario a tela
 * parece um catalogo de promessas com uma funcao real perdida no meio.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { funcaoDisponivel } from "@/lib/ia/conceitos";
import {
  MOCK_AVISO,
  MOCK_CONEXOES,
  MOCK_FUNCOES,
  MOCK_NIVEL_DA_FUNCAO,
} from "@/lib/ia/mocks";
import CardFuncao from "@/components/ia/capabilities/CardFuncao";

export default function AbaFuncoes() {
  const ordenadas = [...MOCK_FUNCOES].sort(
    (a, b) => Number(funcaoDisponivel(b)) - Number(funcaoDisponivel(a))
  );

  return (
    <section aria-label="Funções deste agente">
      <style>{css}</style>

      <header className="cds-ia-af-topo">
        <div>
          <h3 className="cds-ia-af-titulo">Funções deste agente</h3>
          <p className="cds-ia-af-sub">
            Uma função é algo concreto que o agente é capaz de fazer usando recursos
            controlados pelo CDS.
          </p>
        </div>
        <span className="cds-ia-af-simulado">{MOCK_AVISO}</span>
      </header>

      <dl className="cds-ia-af-legenda">
        <div>
          <dt>Disponível</dt>
          <dd>o sistema sabe executar esta função hoje.</dd>
        </div>
        <div>
          <dt>Em breve</dt>
          <dd>o sistema ainda não oferece esta função.</dd>
        </div>
        <div>
          <dt>Permitida</dt>
          <dd>este agente pode usá-la.</dd>
        </div>
        <div>
          <dt>Bloqueada</dt>
          <dd>este agente não pode — a ferramenta nem chega até ele.</dd>
        </div>
      </dl>

      <div className="cds-ia-af-grade">
        {ordenadas.map((f) => (
          <CardFuncao
            key={f.id}
            funcao={f}
            nivel={MOCK_NIVEL_DA_FUNCAO(f.id)}
            conexao={
              f.conexaoNecessaria === null
                ? null
                : MOCK_CONEXOES.find((c) => c.id === f.conexaoNecessaria && c.atribuida) ?? null
            }
          />
        ))}
      </div>
    </section>
  );
}

const css = `
  .cds-ia-af-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.md}px;
  }
  .cds-ia-af-titulo { margin: 0; font: 800 15px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-af-sub {
    margin: 6px 0 0; max-width: 62ch;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-af-simulado {
    flex-shrink: 0;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; background: ${CROMO.acentoFundo};
    color: ${CROMO.acento}; font: 700 11px/1.6 ${FONTE.interface};
  }
  .cds-ia-af-legenda {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 6px 18px; margin: 0 0 ${ESPACO.lg}px;
    padding: 12px 14px;
    border: 1px solid ${CROMO.bordaSutil}; border-radius: ${RAIO.controle}px;
    font: 12px/1.5 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-af-legenda dt { display: inline; font-weight: 700; color: ${CROMO.texto}; }
  .cds-ia-af-legenda dd { display: inline; margin: 0 0 0 4px; }
  .cds-ia-af-grade {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 12px;
    align-items: start;
  }
`;
