/**
 * Card de uma solicitacao de aprovacao.
 *
 * ── Os quatro pedacos ficam separados na tela ───────────────────────
 *
 * Acao em destaque, motivo em bloco proprio, risco como selo, conexao
 * com o estado dela. O usuario aprova a ACAO; o resto e contexto para
 * decidir. Uma frase unica misturando os quatro deixaria o modelo
 * escolher o proprio escopo.
 *
 * ── Botoes existem, desabilitados, e dizem por que ──────────────────
 *
 * Sem `onClick`, sem estado local, sem toast, sem loading. Um botao que
 * muda algo na tela e nao grava nada e pior que botao nenhum: ensina que
 * decidiu. Aqui `disabled` e real, e o motivo aparece em TEXTO ao lado —
 * `disabled` sozinho comunica "indisponivel" mas nunca "por que".
 *
 * Sao dois motivos possiveis e eles se acumulam: o fluxo nao existe, e a
 * conexao pode estar invalida. Mostrar so o primeiro faria o usuario
 * reconectar a conta para descobrir que ainda assim nao da.
 */
import Link from "next/link";
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  ROTULO_ACESSO,
  ROTULO_PROCEDENCIA,
  ROTULO_RISCO,
  VOCABULARIO_CONEXAO,
  type Risco,
} from "@/lib/ia/conceitos";
import {
  EXPLICACAO_INELEGIVEL,
  desdeQuando,
  elegibilidade,
  type AprovacaoUI,
} from "@/lib/ia/aprovacoes";
import DetalheAprovacao from "@/components/ia/aprovacoes/DetalheAprovacao";

const COR_RISCO: Record<Risco, string> = {
  baixo: CORES_ESTADO.ocioso,
  medio: CORES_ESTADO.aguardando_aprovacao,
  alto: CORES_ESTADO.erro,
};

/** Simbolo por risco: o nivel nunca depende so da cor. */
const SIMBOLO_RISCO: Record<Risco, string> = {
  baixo: "▁",
  medio: "▄",
  alto: "█",
};

export default function CardAprovacao({
  aprovacao,
  agoraMs,
}: {
  aprovacao: AprovacaoUI;
  agoraMs: number;
}) {
  const { motivos } = elegibilidade(aprovacao);
  const cor = COR_RISCO[aprovacao.risco];
  const acesso = ROTULO_ACESSO[aprovacao.acao.acesso];
  const idTitulo = `cds-ia-ap-${aprovacao.id}`;

  return (
    <article className="cds-ia-ap-card" aria-labelledby={idTitulo}>
      <style>{css}</style>

      <header className="cds-ia-ap-topo">
        <div className="cds-ia-ap-quem">
          <span className="cds-ia-ap-agente">{aprovacao.agenteNome}</span>
          <span className="cds-ia-ap-quando">solicitou {desdeQuando(aprovacao.solicitadaEm, agoraMs)}</span>
        </div>
        <span className="cds-ia-ap-risco" style={{ borderColor: cor, color: cor }}>
          <span aria-hidden="true">{SIMBOLO_RISCO[aprovacao.risco]}</span>{" "}
          {ROTULO_RISCO[aprovacao.risco]}
        </span>
      </header>

      <h3 id={idTitulo} className="cds-ia-ap-acao">
        {aprovacao.acao.rotulo}
      </h3>
      <p className="cds-ia-ap-acao-meta">
        <span className="cds-ia-ap-cap">{aprovacao.acao.capabilityId}</span>
        {" · "}
        <span aria-hidden="true">{acesso.icone}</span> {acesso.rotulo}
        {" · "}
        <span className="cds-ia-ap-futuro">Cenário futuro</span>
      </p>

      <div className="cds-ia-ap-bloco">
        <span className="cds-ia-ap-rotulo">Motivo</span>
        <p className="cds-ia-ap-texto">{aprovacao.motivo}</p>
      </div>

      <div className="cds-ia-ap-bloco">
        <span className="cds-ia-ap-rotulo">Conexão</span>
        {aprovacao.conexao === null ? (
          <p className="cds-ia-ap-texto">Não depende de conta externa.</p>
        ) : (
          <p className="cds-ia-ap-texto">
            {aprovacao.conexao.rotulo} — {aprovacao.conexao.conta}{" "}
            <span
              className="cds-ia-ap-conexao-estado"
              style={{
                color:
                  aprovacao.conexao.estado === "conectada"
                    ? CORES_ESTADO.concluido
                    : CORES_ESTADO.aguardando_aprovacao,
              }}
            >
              <span aria-hidden="true">{VOCABULARIO_CONEXAO[aprovacao.conexao.estado].icone}</span>{" "}
              {VOCABULARIO_CONEXAO[aprovacao.conexao.estado].rotulo}
            </span>
          </p>
        )}
      </div>

      <DetalheAprovacao aprovacao={aprovacao} />

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
          {motivos.map((m) => (
            <li key={m}>
              {EXPLICACAO_INELEGIVEL[m]}
              {m === "conexao_invalida" && (
                <>
                  {" "}
                  <Link href="/ia/conexoes">Ver conexões</Link>.
                </>
              )}
            </li>
          ))}
        </ul>

        <span className="cds-ia-ap-proc">{ROTULO_PROCEDENCIA[aprovacao.procedencia]}</span>
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
  .cds-ia-ap-risco {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border: 1px solid; border-radius: 999px;
    font-size: 11px; font-weight: 700; white-space: nowrap;
  }

  .cds-ia-ap-acao { margin: ${ESPACO.md}px 0 0; font-size: 17px; font-weight: 800; }
  .cds-ia-ap-acao-meta { margin: 4px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-cap { font-family: ${FONTE.palco}; font-size: 11px; }
  .cds-ia-ap-futuro {
    padding: 1px 7px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; color: ${CROMO.acento};
    font-size: 10px; font-weight: 700;
  }

  .cds-ia-ap-bloco { margin-top: ${ESPACO.lg}px; }
  .cds-ia-ap-rotulo {
    display: block; margin-bottom: 3px;
    font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase;
    color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-texto { margin: 0; overflow-wrap: anywhere; }
  .cds-ia-ap-conexao-estado { font-size: 12px; font-weight: 700; white-space: nowrap; }

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
  .cds-ia-ap-aprovar { border-color: rgba(0,217,126,.3); color: ${CORES_ESTADO.concluido}; }
  .cds-ia-ap-recusar { border-color: rgba(240,106,106,.3); color: ${CORES_ESTADO.erro}; }

  .cds-ia-ap-motivos {
    margin: ${ESPACO.md}px 0 0; padding-left: 18px;
    font-size: 12px; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-motivos li { margin-bottom: 4px; }
  .cds-ia-ap-motivos a { color: ${CROMO.acento}; }
  .cds-ia-ap-motivos a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }

  .cds-ia-ap-proc {
    display: block; margin-top: ${ESPACO.md}px;
    font-size: 10px; letter-spacing: 1px; color: ${CROMO.textoFraco};
  }
`;
