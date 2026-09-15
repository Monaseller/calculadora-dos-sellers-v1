"use client";

/**
 * A fila de aprovacoes — agora REAL.
 *
 * ── O que mudou, e por que importa ──────────────────────────────────
 *
 * Ate aqui esta tela mostrava `MOCK_APROVACOES`: campanhas ficticias que
 * ninguem pediu. Agora ela le `GET /api/aprovacoes`, que devolve as
 * Approvals pendentes do DONO, ainda validas, escopadas no banco.
 *
 * O mock continua existindo e continua servindo `Timeline` e o contador
 * do Escritorio — superficies que ainda simulam. Quem parou de consumi-lo
 * foi esta fila, e so ela.
 *
 * ── Erro NAO cai para mock ──────────────────────────────────────────
 *
 * Se o GET falhar, a tela diz que falhou e oferece "Atualizar". Mostrar
 * dado ficticio no lugar de uma falha seria a pior combinacao possivel
 * numa fila de autorizacao: o dono veria "nenhuma pendencia" — ou pior,
 * pendencias que nao existem — e fecharia a aba.
 *
 * ── Fila, nao historico ─────────────────────────────────────────────
 *
 * Mostra SOMENTE o que precisa de decisao agora. O servidor ja filtra
 * `estado = pendente` e `expira_em > agora`; esta tela nao refiltra.
 *
 * ── Carrega uma vez, atualiza a pedido ──────────────────────────────
 *
 * Sem polling, sem intervalo, sem realtime. Uma fila de decisao humana
 * nao precisa de segundos de latencia, e um intervalo aberto numa aba
 * esquecida bateria na rota para sempre.
 *
 * ── Ordem ───────────────────────────────────────────────────────────
 *
 * A rota ja entrega mais recentes primeiro, com desempate estavel. Esta
 * tela NAO reordena: duas ordens sobre a mesma lista seriam duas
 * verdades sobre o que e "o topo da fila".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { listarAprovacoesPendentes } from "@/lib/ia/agentes-http";
import type { AprovacaoRealUI } from "@/lib/ia/aprovacoes";
import CardAprovacao from "@/components/ia/aprovacoes/CardAprovacao";
import EstadoVazio from "@/components/ia/EstadoVazio";

type Estado =
  | { fase: "carregando" }
  | { fase: "ok"; aprovacoes: readonly AprovacaoRealUI[] }
  | { fase: "erro"; mensagem: string };

const MSG_FALHA = "Não foi possível carregar a fila de aprovações.";
const MSG_SESSAO = "Sua sessão expirou. Entre novamente para ver a fila.";

export default function FilaAprovacoes() {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  // "solicitada ha X" depende do relogio. Ler no servidor e de novo no
  // cliente produziria HTML divergente — mesmo motivo do Escritorio.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);

  /** Trava SINCRONA. `fase === "carregando"` so vira verdade num render,
   *  e dois cliques no mesmo frame atravessam essa janela juntos. Um ref
   *  muda no instante em que e escrito. */
  const emCursoRef = useRef(false);
  /** Contador de geracao: resposta antiga que chega depois de uma nova
   *  nao pode sobrescrever a nova, e nada e escrito apos desmontar. */
  const geracao = useRef(0);
  const vivo = useRef(true);

  const carregar = useCallback(async () => {
    if (emCursoRef.current) return;
    emCursoRef.current = true;

    const minha = ++geracao.current;
    setEstado({ fase: "carregando" });

    const resposta = await listarAprovacoesPendentes();

    if (!vivo.current || minha !== geracao.current) {
      emCursoRef.current = false;
      return;
    }

    if (resposta.estado === "ok") {
      setEstado({ fase: "ok", aprovacoes: resposta.aprovacoes });
    } else if (resposta.estado === "nao_autenticado") {
      setEstado({ fase: "erro", mensagem: MSG_SESSAO });
    } else {
      setEstado({ fase: "erro", mensagem: MSG_FALHA });
    }

    setAgoraMs(Date.now());
    emCursoRef.current = false;
  }, []);

  useEffect(() => {
    vivo.current = true;
    setAgoraMs(Date.now());
    void carregar();
    return () => {
      vivo.current = false;
    };
  }, [carregar]);

  const atualizar = (
    <button
      type="button"
      className="cds-ia-fila-atualizar"
      onClick={() => void carregar()}
      disabled={estado.fase === "carregando"}
    >
      Atualizar
    </button>
  );

  if (estado.fase === "carregando") {
    return (
      <section aria-label="Aprovações pendentes" aria-busy="true">
        <style>{css}</style>
        <p className="cds-ia-fila-carregando">Carregando a fila…</p>
      </section>
    );
  }

  if (estado.fase === "erro") {
    return (
      <section aria-label="Aprovações pendentes">
        <style>{css}</style>
        <p className="cds-ia-fila-erro" role="alert">
          {estado.mensagem}
        </p>
        {atualizar}
      </section>
    );
  }

  if (estado.aprovacoes.length === 0) {
    return (
      <section aria-label="Aprovações pendentes">
        <style>{css}</style>
        <EstadoVazio
          titulo="Nenhuma aprovação pendente"
          descricao="Seus agentes não estão aguardando nenhuma decisão."
        />
        <div className="cds-ia-fila-rodape-vazio">{atualizar}</div>
      </section>
    );
  }

  const fila = estado.aprovacoes;

  return (
    <section aria-label="Aprovações pendentes">
      <style>{css}</style>

      <header className="cds-ia-fila-topo">
        <div>
          <h2 className="cds-ia-fila-titulo">
            {fila.length}{" "}
            {fila.length === 1 ? "solicitação aguarda" : "solicitações aguardam"} sua decisão
          </h2>
          <p className="cds-ia-fila-sub">
            Seus agentes prepararam estas ações, mas não podem executá-las sozinhos. Nada acontece
            até você decidir.
          </p>
        </div>
        {atualizar}
      </header>

      <ul className="cds-ia-fila-lista">
        {fila.map((a) => (
          <li key={a.id}>
            <CardAprovacao aprovacao={a} agoraMs={agoraMs ?? 0} />
          </li>
        ))}
      </ul>

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
  .cds-ia-fila-atualizar {
    flex-shrink: 0;
    padding: 7px 16px; border-radius: ${RAIO.controle}px;
    border: 1px solid ${CROMO.borda}; background: transparent;
    font: 700 12px/1 ${FONTE.interface}; color: ${CROMO.texto};
    cursor: pointer;
  }
  .cds-ia-fila-atualizar:disabled { cursor: not-allowed; opacity: .55; }
  .cds-ia-fila-atualizar:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }
  .cds-ia-fila-rodape-vazio { margin-top: ${ESPACO.lg}px; text-align: center; }
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
  .cds-ia-fila-erro {
    margin: 0 0 ${ESPACO.md}px; padding: 12px 14px;
    border: 1px solid ${CROMO.borda}; border-radius: ${RAIO.controle}px;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.texto};
    max-width: 72ch;
  }
  .cds-ia-fila-nota {
    margin: ${ESPACO.lg}px 0 0; padding: 12px 14px;
    border: 1px solid ${CROMO.bordaSutil}; border-radius: ${RAIO.controle}px;
    max-width: 72ch;
  }
`;
