"use client";

/**
 * A fila de aprovacoes.
 *
 * ── Fila, nao historico ─────────────────────────────────────────────
 *
 * Mostra SOMENTE o que precisa de decisao agora. Aprovadas, recusadas e
 * concluidas vao para `/ia/atividade` quando aquela area existir. Uma
 * caixa de entrada que nunca esvazia deixa de ser caixa de entrada: o
 * que exige acao se perde no meio do que ja foi resolvido.
 *
 * ── Sem filtros nesta versao ────────────────────────────────────────
 *
 * Uma fila que precisa de filtro ja e grande demais para ser fila. Se
 * crescer a ponto de precisar, o primeiro filtro util e por agente — e
 * ai a conversa e outra.
 *
 * ── Ordem ───────────────────────────────────────────────────────────
 *
 * Mais antigas primeiro. Quem espera ha mais tempo aparece no topo; o
 * contrario faria pedidos antigos afundarem justamente por serem antigos.
 */
import { useEffect, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { maisAntigasPrimeiro } from "@/lib/ia/aprovacoes";
import { MOCK_APROVACOES, MOCK_AVISO } from "@/lib/ia/mocks";
import CardAprovacao from "@/components/ia/aprovacoes/CardAprovacao";
import EstadoVazio from "@/components/ia/EstadoVazio";

export default function FilaAprovacoes() {
  // "solicitada ha X" depende do relogio. Ler no servidor e de novo no
  // cliente produziria HTML divergente — mesmo motivo do Escritorio.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  useEffect(() => setAgoraMs(Date.now()), []);

  if (MOCK_APROVACOES.length === 0) {
    return (
      <EstadoVazio
        titulo="Nenhuma aprovação pendente"
        descricao="Seus agentes não estão aguardando nenhuma decisão."
      />
    );
  }

  const fila = maisAntigasPrimeiro(MOCK_APROVACOES);

  return (
    <section aria-label="Aprovações pendentes">
      <style>{css}</style>

      <header className="cds-ia-fila-topo">
        <div>
          <h2 className="cds-ia-fila-titulo">
            {fila.length} {fila.length === 1 ? "solicitação aguarda" : "solicitações aguardam"} sua decisão
          </h2>
          <p className="cds-ia-fila-sub">
            Seus agentes prepararam estas ações, mas não podem executá-las sozinhos. Nada acontece
            até você decidir.
          </p>
        </div>
        <span className="cds-ia-fila-simulado">{MOCK_AVISO}</span>
      </header>

      {agoraMs === null ? (
        <p className="cds-ia-fila-carregando">Carregando…</p>
      ) : (
        <ul className="cds-ia-fila-lista">
          {fila.map((a) => (
            <li key={a.id}>
              <CardAprovacao aprovacao={a} agoraMs={agoraMs} />
            </li>
          ))}
        </ul>
      )}

      <p className="cds-ia-fila-nota">
        Decisões já tomadas não ficam aqui: quando a área de Atividade existir, o histórico de
        aprovações e recusas viverá lá.
      </p>
    </section>
  );
}

const css = `
  .cds-ia-fila-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-fila-titulo { margin: 0; font: 800 16px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-fila-sub {
    margin: 6px 0 0; max-width: 66ch;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-fila-simulado {
    flex-shrink: 0;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; background: ${CROMO.acentoFundo};
    color: ${CROMO.acento}; font: 700 11px/1.6 ${FONTE.interface};
  }
  .cds-ia-fila-lista {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
    gap: 12px;
    margin: 0; padding: 0; list-style: none;
    align-items: start;
  }
  .cds-ia-fila-carregando, .cds-ia-fila-nota {
    font: 12px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-fila-nota {
    margin: ${ESPACO.lg}px 0 0; padding: 12px 14px;
    border: 1px solid ${CROMO.bordaSutil}; border-radius: ${RAIO.controle}px;
    max-width: 72ch;
  }
`;
