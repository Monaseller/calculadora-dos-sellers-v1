/**
 * Uma linha do feed de atividade.
 *
 * ── Compacto de proposito ───────────────────────────────────────────
 *
 * Agente, o que aconteceu, quando. E so. Progresso, tentativa, duracao e
 * espera na fila NAO aparecem aqui: sao atributos de ESTADO e vivem na
 * aba Tarefas. Repeti-los transformaria o feed numa segunda aba Tarefas,
 * pior organizada.
 *
 * ── `<details>` so quando ha o que detalhar ─────────────────────────
 *
 * `detalhe === null` significa "nao ha informacao adicional segura", e
 * a linha simplesmente nao ganha um `<details>`. Um acordeao vazio em
 * toda linha e ruido que ensina o usuario a nunca abrir nenhum.
 */
import Link from "next/link";
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { ROTULO_PROCEDENCIA } from "@/lib/ia/conceitos";
import {
  ROTULO_ATOR,
  VOCABULARIO_EVENTO,
  type EventoAtividade,
  type Severidade,
} from "@/lib/ia/atividade";
import { desdeQuando } from "@/lib/ia/aprovacoes";
import { formatarInstante } from "@/lib/ia/tarefas";

const COR_SEVERIDADE: Record<Severidade, string> = {
  info: CORES_ESTADO.ocioso,
  atencao: CORES_ESTADO.aguardando_aprovacao,
  erro: CORES_ESTADO.erro,
};

export default function ItemAtividade({
  evento,
  agoraMs,
}: {
  evento: EventoAtividade;
  agoraMs: number;
}) {
  const vocab = VOCABULARIO_EVENTO[evento.tipo];
  const cor = COR_SEVERIDADE[evento.severidade];

  return (
    <li className="cds-ia-at-item">
      <style>{css}</style>

      {/* Icone: redundante com o rotulo do tipo ao lado, entao fica
          escondido do leitor de tela. A cor nunca carrega sozinha. */}
      <span className="cds-ia-at-icone" style={{ color: cor, borderColor: cor }} aria-hidden="true">
        {vocab.icone}
      </span>

      <div className="cds-ia-at-corpo">
        <p className="cds-ia-at-linha">
          <span className="cds-ia-at-agente">{evento.agenteNome}</span>{" "}
          <span className="cds-ia-at-frase">{evento.frase}</span>
        </p>

        <p className="cds-ia-at-meta">
          <span style={{ color: cor }}>{vocab.rotulo}</span>
          {" · "}
          <time dateTime={evento.instante} title={formatarInstante(evento.instante)}>
            {desdeQuando(evento.instante, agoraMs)}
          </time>
          {" · "}
          {ROTULO_ATOR[evento.ator.tipo]}
          {/* Procedencia so aparece quando NAO e dado real: repetir
              "Dado real" em toda linha viraria ruido, e o que precisa de
              destaque e o que ainda nao existe. */}
          {evento.procedencia !== "disponivel" && (
            <>
              {" · "}
              <span className="cds-ia-at-proc">{ROTULO_PROCEDENCIA[evento.procedencia]}</span>
            </>
          )}
        </p>

        {evento.detalhe !== null && (
          <details className="cds-ia-at-det">
            <summary>Detalhes</summary>
            <p className="cds-ia-at-det-texto">{evento.detalhe}</p>
          </details>
        )}

        {evento.link !== null && (
          <p className="cds-ia-at-link">
            <Link href={evento.link.href}>{evento.link.rotulo} →</Link>
          </p>
        )}
      </div>
    </li>
  );
}

const css = `
  .cds-ia-at-item {
    display: flex; gap: ${ESPACO.md}px; align-items: flex-start;
    padding: ${ESPACO.lg}px 0;
    border-bottom: 1px solid ${CROMO.bordaSutil};
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-at-item:last-child { border-bottom: none; }
  .cds-ia-at-icone {
    flex-shrink: 0;
    display: grid; place-items: center;
    width: 26px; height: 26px;
    border: 1px solid; border-radius: 999px;
    font-size: 12px; font-weight: 700;
  }
  .cds-ia-at-corpo { flex: 1; min-width: 0; }
  .cds-ia-at-linha { margin: 0; overflow-wrap: anywhere; }
  .cds-ia-at-agente { font-weight: 700; }
  .cds-ia-at-frase { color: ${CROMO.texto}; }
  .cds-ia-at-meta { margin: 3px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-at-proc {
    padding: 1px 7px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; color: ${CROMO.acento};
    font-size: 10px; font-weight: 700;
  }
  .cds-ia-at-det { margin-top: ${ESPACO.sm}px; }
  .cds-ia-at-det summary {
    display: inline-block;
    font-size: 12px; color: ${CROMO.textoFraco}; cursor: pointer;
    list-style: none;
  }
  .cds-ia-at-det summary::-webkit-details-marker { display: none; }
  .cds-ia-at-det summary::before { content: "▸ "; }
  .cds-ia-at-det[open] summary::before { content: "▾ "; }
  .cds-ia-at-det summary:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }
  .cds-ia-at-det-texto {
    margin: ${ESPACO.sm}px 0 0; padding: 10px 12px;
    border: 1px solid ${CROMO.bordaSutil}; border-radius: ${RAIO.controle}px;
    font-size: 12px; color: ${CROMO.textoFraco}; overflow-wrap: anywhere;
  }
  .cds-ia-at-link { margin: ${ESPACO.sm}px 0 0; font-size: 12px; }
  .cds-ia-at-link a { color: ${CROMO.acento}; text-decoration: none; }
  .cds-ia-at-link a:hover { text-decoration: underline; }
  .cds-ia-at-link a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }
`;
