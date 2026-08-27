/**
 * Card de uma conexao.
 *
 * ── Dois eixos, nunca fundidos ──────────────────────────────────────
 *
 *   ESTADO      conectada / expirada / desconectada / erro
 *   ATRIBUICAO  atribuida a este agente, ou nao
 *
 * Uma conta pode estar perfeitamente conectada e simplesmente nao ter
 * sido dada a este agente. Se os dois virassem um "status" so, esse caso
 * — que e o mais comum quando ha varias contas — ficaria irrepresentavel.
 *
 * A atribuicao aparece como MOLDURA (tracejada quando nao atribuida), e
 * o estado como badge. Assim o olho separa os dois antes de ler.
 *
 * ── O que este card nunca renderiza ─────────────────────────────────
 *
 * `seller_id`, `shop_id`, `partner_id`, token, chave. Nao por disciplina
 * — o contrato `ConexaoUI` simplesmente nao tem esses campos, entao nao
 * ha o que vazar aqui.
 */
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  ROTULO_PROCEDENCIA,
  VOCABULARIO_CONEXAO,
  type ConexaoUI,
  type EstadoConexao,
  type FuncaoUI,
} from "@/lib/ia/conceitos";
import { formatarInstante } from "@/lib/ia/tarefas";

const COR_ESTADO: Record<EstadoConexao, string> = {
  conectada: CORES_ESTADO.concluido,
  expirada: CORES_ESTADO.aguardando_aprovacao,
  desconectada: CORES_ESTADO.ocioso,
  erro: CORES_ESTADO.erro,
};

export default function CardConexao({
  conexao,
  funcoesQueUsam,
}: {
  conexao: ConexaoUI;
  funcoesQueUsam: readonly FuncaoUI[];
}) {
  const vocab = VOCABULARIO_CONEXAO[conexao.estado];
  const cor = COR_ESTADO[conexao.estado];

  return (
    <article
      className={conexao.atribuida ? "cds-ia-cx cds-ia-cx-atribuida" : "cds-ia-cx"}
      aria-label={`${conexao.rotulo}, conta ${conexao.conta}, ${vocab.rotulo}, ${
        conexao.atribuida ? "atribuída a este agente" : "não atribuída a este agente"
      }`}
    >
      <style>{css}</style>

      <header className="cds-ia-cx-topo">
        <div>
          <h3 className="cds-ia-cx-titulo">{conexao.rotulo}</h3>
          <p className="cds-ia-cx-conta">{conexao.conta}</p>
        </div>

        <span className="cds-ia-cx-estado" style={{ borderColor: cor, color: cor }}>
          <span aria-hidden="true">{vocab.icone}</span> {vocab.rotulo}
        </span>
      </header>

      <p className="cds-ia-cx-explicacao">{vocab.explicacao}</p>

      <dl className="cds-ia-cx-campos">
        <div>
          <dt>Atribuição</dt>
          <dd>{conexao.atribuida ? "Atribuída a este agente" : "Não atribuída"}</dd>
        </div>
        <div>
          <dt>Última sincronização</dt>
          <dd>
            {conexao.ultimaSincronizacao === null
              ? "Nunca sincronizou"
              : formatarInstante(conexao.ultimaSincronizacao)}
          </dd>
        </div>
      </dl>

      <div className="cds-ia-cx-usos">
        <span className="cds-ia-cx-rotulo">Usada por</span>
        {funcoesQueUsam.length === 0 ? (
          <p className="cds-ia-cx-vazio">
            Nenhuma função deste agente depende desta conexão.
          </p>
        ) : (
          <ul className="cds-ia-cx-lista">
            {funcoesQueUsam.map((f) => (
              <li key={f.id}>{f.rotulo}</li>
            ))}
          </ul>
        )}
      </div>

      <footer className="cds-ia-cx-rodape">{ROTULO_PROCEDENCIA[conexao.procedencia]}</footer>
    </article>
  );
}

const css = `
  .cds-ia-cx {
    display: flex;
    flex-direction: column;
    padding: ${ESPACO.lg}px;
    border: 1px dashed ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    background: transparent;
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  /* Atribuida = moldura solida e fundo. Nao atribuida = tracejada e
     transparente. A diferenca e perceptivel antes da leitura. */
  .cds-ia-cx-atribuida {
    border-style: solid;
    background: ${CROMO.fundoCard};
  }
  .cds-ia-cx-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .cds-ia-cx-titulo { margin: 0; font-size: 15px; font-weight: 800; }
  .cds-ia-cx-conta { margin: 2px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-cx-estado {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border: 1px solid; border-radius: 999px;
    font-size: 11px; font-weight: 700; white-space: nowrap;
  }
  .cds-ia-cx-explicacao { margin: 12px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-cx-campos {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px 16px; margin: 14px 0 0;
  }
  .cds-ia-cx-campos dt { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-cx-campos dd { margin: 2px 0 0; font-size: 13px; }
  .cds-ia-cx-usos { margin-top: 14px; }
  .cds-ia-cx-rotulo { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-cx-lista { margin: 4px 0 0; padding-left: 18px; }
  .cds-ia-cx-lista li { margin-bottom: 2px; }
  .cds-ia-cx-vazio { margin: 4px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-cx-rodape {
    margin-top: 14px; padding-top: 10px;
    border-top: 1px solid ${CROMO.bordaSutil};
    font-size: 10px; letter-spacing: 1px; color: ${CROMO.textoFraco};
  }
`;
