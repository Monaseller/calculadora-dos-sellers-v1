/**
 * Card de uma solicitacao de aprovacao REAL.
 *
 * ── O card encolheu, e isso e a correcao ────────────────────────────
 *
 * A versao anterior mostrava motivo do agente, impacto se aprovada,
 * risco com simbolo e o estado da conexao. Nada disso existe em
 * `agente_funcao_aprovacoes`: eram campos do mock. Mantê-los obrigaria a
 * inventar cada um — e inventar numa tela de autorizacao e pedir que
 * alguem decida com base em texto que o sistema nao sabe se e verdade.
 * O que ficou e o que o servidor publica: quem pediu, qual Funcao, que
 * acesso ela tem, quando pediu, quando expira e os argumentos.
 *
 * `DetalheAprovacao` tambem saiu por isso: ele e tipado para o contrato
 * mock (`impacto`, `risco`, `nivelExigido`). Ele nao foi alterado nem
 * removido — ficou sem consumidor, registrado como divida A2-L1.
 *
 * ── Argumentos por Funcao, nunca por varredura ──────────────────────
 *
 * `detalhesDaSolicitacao` tem um renderer NOMINAL por Funcao. Funcao sem
 * renderer, argumento com forma inesperada ou marketplace fora do
 * vocabulario caem todos na mesma frase honesta. Em nenhum caso o objeto
 * e despejado na tela: um `JSON.stringify` aqui transformaria a falta de
 * um renderer em vazamento de forma interna.
 *
 * ── Botoes existem, desabilitados, e dizem por que ──────────────────
 *
 * Sem `onClick`, sem estado local, sem toast. Continua valendo o que
 * valia na era mock, e agora por um motivo mais concreto: aprovar
 * deixaria a Approval `aprovada` e a tarefa parada em
 * `aguardando_aprovacao` para sempre, porque nada ainda a consome.
 */
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { ROTULO_ACESSO } from "@/lib/ia/conceitos";
import {
  EXPLICACAO_INELEGIVEL,
  SEM_DETALHES,
  desdeQuando,
  detalhesDaSolicitacao,
  expirouLocalmente,
  rotuloDaFuncao,
  type AprovacaoRealUI,
} from "@/lib/ia/aprovacoes";

/** `criadoEm` e `expiraEm` sao ISO completos do banco, nao datas civis:
 *  aqui o horario local e o correto, e nao ha dia a deslocar. */
function momento(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CardAprovacao({
  aprovacao,
  agoraMs,
}: {
  aprovacao: AprovacaoRealUI;
  agoraMs: number;
}) {
  const detalhes = detalhesDaSolicitacao(aprovacao);
  const expirada = expirouLocalmente(aprovacao, agoraMs);
  const acesso = ROTULO_ACESSO[aprovacao.acesso === "escrita" ? "escrita" : "leitura"];
  const idTitulo = `cds-ia-ap-${aprovacao.id}`;

  return (
    <article className="cds-ia-ap-card" aria-labelledby={idTitulo}>
      <style>{css}</style>

      <header className="cds-ia-ap-topo">
        <div className="cds-ia-ap-quem">
          <span className="cds-ia-ap-agente">{aprovacao.agenteNome}</span>
          <span className="cds-ia-ap-quando">
            solicitou {desdeQuando(aprovacao.criadoEm, agoraMs)}
          </span>
        </div>
        {expirada && (
          <span className="cds-ia-ap-expirada">Expirada — atualize a fila</span>
        )}
      </header>

      <h3 id={idTitulo} className="cds-ia-ap-acao">
        {rotuloDaFuncao(aprovacao.funcaoId)}
      </h3>
      <p className="cds-ia-ap-acao-meta">
        <span className="cds-ia-ap-cap">{aprovacao.funcaoId}</span>
        {" · "}
        <span aria-hidden="true">{acesso.icone}</span> {acesso.rotulo}
      </p>

      <div className="cds-ia-ap-bloco">
        <span className="cds-ia-ap-rotulo">Solicitação</span>
        {detalhes === null ? (
          <p className="cds-ia-ap-texto">{SEM_DETALHES}</p>
        ) : (
          <dl className="cds-ia-ap-detalhes">
            {detalhes.map((d) => (
              <div key={d.rotulo}>
                <dt>{d.rotulo}</dt>
                <dd>{d.valor}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="cds-ia-ap-bloco">
        <span className="cds-ia-ap-rotulo">Conexão</span>
        {aprovacao.conexao === null ? (
          <p className="cds-ia-ap-texto">Não depende de conta externa.</p>
        ) : (
          <p className="cds-ia-ap-texto">
            {aprovacao.conexao.plataforma} — {aprovacao.conexao.recurso}
          </p>
        )}
      </div>

      <div className="cds-ia-ap-bloco">
        <span className="cds-ia-ap-rotulo">Prazo</span>
        <p className="cds-ia-ap-texto">
          Pedida em {momento(aprovacao.criadoEm)} · expira em {momento(aprovacao.expiraEm)}
        </p>
      </div>

      <footer className="cds-ia-ap-rodape">
        <div className="cds-ia-ap-acoes">
          <button type="button" className="cds-ia-ap-btn cds-ia-ap-recusar" disabled>
            Recusar
          </button>
          <button type="button" className="cds-ia-ap-btn cds-ia-ap-aprovar" disabled>
            Aprovar
          </button>
        </div>

        <ul className="cds-ia-ap-motivos">
          <li>{EXPLICACAO_INELEGIVEL.fluxo_nao_conectado}</li>
        </ul>
      </footer>
    </article>
  );
}

const css = `
  .cds-ia-ap-card {
    padding: ${ESPACO.xl}px;
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    background: ${CROMO.fundoCard};
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-ap-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .cds-ia-ap-quem { display: flex; flex-direction: column; }
  .cds-ia-ap-agente { font-weight: 700; }
  .cds-ia-ap-quando { font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-expirada {
    flex-shrink: 0;
    padding: 3px 10px; border: 1px solid; border-radius: 999px;
    border-color: ${CORES_ESTADO.erro}; color: ${CORES_ESTADO.erro};
    font-size: 11px; font-weight: 700; white-space: nowrap;
  }

  .cds-ia-ap-acao { margin: ${ESPACO.md}px 0 0; font-size: 17px; font-weight: 800; }
  .cds-ia-ap-acao-meta { margin: 4px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-cap { font-family: ${FONTE.palco}; font-size: 11px; }

  .cds-ia-ap-bloco { margin-top: ${ESPACO.lg}px; }
  .cds-ia-ap-rotulo {
    display: block; margin-bottom: 3px;
    font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
    color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-texto { margin: 0; overflow-wrap: anywhere; }
  .cds-ia-ap-detalhes {
    margin: 0; display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px 16px;
  }
  .cds-ia-ap-detalhes dt {
    font-size: 11px; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-detalhes dd { margin: 0; font-weight: 700; overflow-wrap: anywhere; }

  .cds-ia-ap-rodape {
    margin-top: ${ESPACO.xl}px; padding-top: ${ESPACO.md}px;
    border-top: 1px solid ${CROMO.bordaSutil};
  }
  .cds-ia-ap-acoes { display: flex; gap: ${ESPACO.sm}px; flex-wrap: wrap; }
  .cds-ia-ap-btn {
    padding: 9px 20px;
    border-radius: ${RAIO.controle}px;
    border: 1px solid ${CROMO.borda};
    background: transparent;
    font: 700 13px/1 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  /* Desabilitado tem cursor de bloqueio e contraste reduzido MAS legivel:
     opacity baixa demais deixaria o rotulo ilegivel, e o rotulo e o que
     diz o que o botao faria. */
  .cds-ia-ap-btn:disabled { cursor: not-allowed; opacity: .55; }
  .cds-ia-ap-btn:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }
  .cds-ia-ap-aprovar { border-color: rgba(0,217,126,.3); color: ${CORES_ESTADO.concluido}; }
  .cds-ia-ap-recusar { border-color: rgba(240,106,106,.3); color: ${CORES_ESTADO.erro}; }

  .cds-ia-ap-motivos {
    margin: ${ESPACO.md}px 0 0; padding-left: 18px;
    font-size: 12px; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-motivos li { margin-bottom: 4px; }
`;
