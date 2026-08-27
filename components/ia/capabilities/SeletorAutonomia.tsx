/**
 * Representacao dos tres niveis de autonomia. ESTATICA.
 *
 * ── O nome diz "Seletor"; o componente nao seleciona nada ───────────
 *
 * O nome e do conceito, nao da interacao — e o lugar onde o seletor
 * VAI existir quando houver onde gravar a decisao. Hoje nao ha, e por
 * isso este componente:
 *
 *   nao tem onChange, onClick, input, select, radio nem botao Salvar;
 *   nao tem `role="radio"` nem `role="radiogroup"`;
 *   nao recebe callback de mudanca.
 *
 * Um radio de verdade anuncia ao leitor de tela "opção 1 de 3,
 * selecionada" e promete que as setas mudam a escolha. Marcar como radio
 * algo que nao muda nada e mentir com ARIA — pior do que nao marcar,
 * porque a mentira e convincente.
 *
 * Entao: uma lista, com o nivel vigente destacado e escrito. Sem falsa
 * affordance, sem cursor de ponteiro, sem hover que sugira clique.
 */
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { NIVEIS_AUTONOMIA, VOCABULARIO_NIVEL, type NivelAutonomia } from "@/lib/ia/conceitos";

const COR_NIVEL: Record<NivelAutonomia, string> = {
  bloqueado: CORES_ESTADO.erro,
  aprovacao: CORES_ESTADO.aguardando_aprovacao,
  automatico: CORES_ESTADO.trabalhando,
};

export default function SeletorAutonomia({
  nivel,
  idRotulo,
}: {
  nivel: NivelAutonomia;
  /** id do heading que nomeia a funcao, para dar contexto a lista. */
  idRotulo?: string;
}) {
  return (
    <>
      <style>{css}</style>
      <ul className="cds-ia-niveis" aria-labelledby={idRotulo}>
        {NIVEIS_AUTONOMIA.map((n) => {
          const vigente = n === nivel;
          const vocab = VOCABULARIO_NIVEL[n];
          return (
            <li
              key={n}
              className={vigente ? "cds-ia-nivel cds-ia-nivel-vigente" : "cds-ia-nivel"}
              style={vigente ? { borderColor: COR_NIVEL[n] } : undefined}
            >
              <span className="cds-ia-nivel-marca" aria-hidden="true" style={vigente ? { color: COR_NIVEL[n] } : undefined}>
                {vigente ? "◉" : "○"}
              </span>

              <div className="cds-ia-nivel-texto">
                <span className="cds-ia-nivel-rotulo">
                  {vocab.rotulo}
                  {/* O estado vigente e dito por TEXTO, nao so pela cor
                      e pelo simbolo — inclusive para leitor de tela. */}
                  {vigente && <span className="cds-ia-nivel-atual"> — configurado</span>}
                </span>
                <span className="cds-ia-nivel-explicacao">{vocab.explicacao}</span>
                <span className="cds-ia-nivel-efeito">{vocab.efeito}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const css = `
  .cds-ia-niveis {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 8px;
    margin: 0; padding: 0; list-style: none;
  }
  .cds-ia-nivel {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px;
    border: 1px solid ${CROMO.bordaSutil};
    border-radius: ${RAIO.controle}px;
    /* Sem cursor: pointer e sem :hover — nada aqui e clicavel. */
    font: 12px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
    opacity: .6;
  }
  .cds-ia-nivel-vigente {
    background: ${CROMO.fundoCard};
    opacity: 1;
  }
  .cds-ia-nivel-marca { font-size: 13px; line-height: 1.3; }
  .cds-ia-nivel-texto { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .cds-ia-nivel-rotulo { font-size: 13px; font-weight: 700; color: ${CROMO.texto}; }
  .cds-ia-nivel-atual { font-weight: 400; font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-nivel-efeito { font-size: 11px; opacity: .85; }
`;
