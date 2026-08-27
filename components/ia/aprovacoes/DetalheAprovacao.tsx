/**
 * Detalhes de uma solicitacao, em expansao inline.
 *
 * ── Por que `<details>` e nao modal ─────────────────────────────────
 *
 * O modal ja e necessario para a confirmacao de acao de alto risco,
 * quando Aprovar for ligado. Usar modal tambem para "ver detalhes"
 * empilharia dialogos — dois niveis de foco preso, dois Escape com
 * significados diferentes.
 *
 * `<details>/<summary>` da de graca: teclado, estado expandido anunciado,
 * Ctrl+F encontrando o conteudo fechado nos navegadores modernos, e
 * nenhum JavaScript. Menos codigo e mais acessivel que um acordeao feito
 * a mao com `aria-expanded`.
 *
 * ── Argumentos ja chegam sanitizados ────────────────────────────────
 *
 * `AcaoCanonica.argumentos` e uma lista de pares legiveis; nao existe
 * campo de payload no contrato. Este componente nao tem, portanto, como
 * despejar JSON — nao por disciplina, por ausencia.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { ROTULO_ACESSO, VOCABULARIO_CONEXAO, VOCABULARIO_NIVEL } from "@/lib/ia/conceitos";
import { formatarInstante } from "@/lib/ia/tarefas";
import type { AprovacaoUI } from "@/lib/ia/aprovacoes";

export default function DetalheAprovacao({ aprovacao }: { aprovacao: AprovacaoUI }) {
  const acesso = ROTULO_ACESSO[aprovacao.acao.acesso];

  return (
    <details className="cds-ia-ap-det">
      <style>{css}</style>
      <summary className="cds-ia-ap-det-abre">Ver detalhes</summary>

      <div className="cds-ia-ap-det-corpo">
        <Bloco titulo="Ação">
          <p className="cds-ia-ap-det-acao">{aprovacao.acao.rotulo}</p>
          <p className="cds-ia-ap-det-id">{aprovacao.acao.capabilityId}</p>
          <p className="cds-ia-ap-det-meta">
            <span aria-hidden="true">{acesso.icone}</span> {acesso.rotulo}
            {aprovacao.acao.irreversivel && " · Não pode ser desfeita"}
          </p>
        </Bloco>

        <Bloco titulo="Argumentos">
          {aprovacao.acao.argumentos.length === 0 ? (
            <p className="cds-ia-ap-det-vazio">Esta ação não recebe argumentos.</p>
          ) : (
            <dl className="cds-ia-ap-det-args">
              {aprovacao.acao.argumentos.map((a) => (
                <div key={a.rotulo}>
                  <dt>{a.rotulo}</dt>
                  <dd>{a.valor}</dd>
                </div>
              ))}
            </dl>
          )}
        </Bloco>

        <Bloco titulo="Motivo do agente">
          <p className="cds-ia-ap-det-texto">{aprovacao.motivo}</p>
          <p className="cds-ia-ap-det-nota">
            O motivo é a justificativa do agente. Ele explica o pedido — não autoriza a ação.
          </p>
        </Bloco>

        <Bloco titulo="Impacto se aprovada">
          <p className="cds-ia-ap-det-texto">{aprovacao.impacto}</p>
        </Bloco>

        <Bloco titulo="Conexão">
          {aprovacao.conexao === null ? (
            <p className="cds-ia-ap-det-texto">Não depende de conta externa.</p>
          ) : (
            <p className="cds-ia-ap-det-texto">
              {aprovacao.conexao.rotulo} — {aprovacao.conexao.conta} ·{" "}
              {VOCABULARIO_CONEXAO[aprovacao.conexao.estado].rotulo}
            </p>
          )}
        </Bloco>

        <Bloco titulo="Origem">
          <dl className="cds-ia-ap-det-args">
            <div>
              <dt>Agente</dt>
              <dd>{aprovacao.agenteNome}</dd>
            </div>
            <div>
              <dt>Solicitada em</dt>
              <dd>{formatarInstante(aprovacao.solicitadaEm)}</dd>
            </div>
            <div>
              <dt>Política que exigiu</dt>
              <dd>{VOCABULARIO_NIVEL[aprovacao.nivelExigido].rotulo}</dd>
            </div>
          </dl>
          <p className="cds-ia-ap-det-nota">
            {VOCABULARIO_NIVEL[aprovacao.nivelExigido].efeito}
          </p>
        </Bloco>
      </div>
    </details>
  );
}

function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="cds-ia-ap-det-bloco">
      <h5 className="cds-ia-ap-det-titulo">{titulo}</h5>
      {children}
    </section>
  );
}

const css = `
  .cds-ia-ap-det { margin-top: ${ESPACO.md}px; }
  .cds-ia-ap-det-abre {
    display: inline-block;
    padding: 6px 12px;
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
    cursor: pointer;
    font: 600 12px/1.4 ${FONTE.interface};
    color: ${CROMO.textoFraco};
    list-style: none;
  }
  .cds-ia-ap-det-abre::-webkit-details-marker { display: none; }
  .cds-ia-ap-det-abre::before { content: "▸ "; }
  .cds-ia-ap-det[open] .cds-ia-ap-det-abre::before { content: "▾ "; }
  .cds-ia-ap-det-abre:hover { color: ${CROMO.texto}; }
  .cds-ia-ap-det-abre:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }

  .cds-ia-ap-det-corpo {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: ${ESPACO.lg}px;
    margin-top: ${ESPACO.md}px;
    padding: ${ESPACO.lg}px;
    border: 1px solid ${CROMO.bordaSutil};
    border-radius: ${RAIO.controle}px;
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-ap-det-titulo {
    margin: 0 0 6px; font-size: 10px; letter-spacing: 1.5px;
    text-transform: uppercase; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-det-acao { margin: 0; font-weight: 700; }
  .cds-ia-ap-det-id { margin: 2px 0 0; font: 11px/1.4 ${FONTE.palco}; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-det-meta { margin: 6px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-det-texto { margin: 0; overflow-wrap: anywhere; }
  .cds-ia-ap-det-vazio { margin: 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-det-nota { margin: 8px 0 0; font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-det-args { margin: 0; }
  .cds-ia-ap-det-args dt { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-det-args dd { margin: 2px 0 8px; overflow-wrap: anywhere; }
`;
