"use client";

/**
 * Shell da pagina individual do agente: identidade no topo, abas, painel.
 *
 * ── Por que Client Component ────────────────────────────────────────
 *
 * O estado do agente depende do relogio (o flash transitorio de
 * conclusao) e as tarefas mockadas sao ancoradas na montagem. Ler o
 * relogio no servidor e de novo no cliente produziria HTML divergente —
 * mesmo motivo do escritorio, e por isso a mesma solucao: `ancoraMs`
 * fixa os dados, `agoraMs` anda.
 *
 * ── Uma so maquina de estados ───────────────────────────────────────
 *
 * A identidade no topo NAO calcula estado proprio: chama
 * `aparenciaDoAgente`, que delega a precedencia a `derivarStatusAgente`
 * do backend. Nenhuma tela desta area tem permissao para inventar um
 * segundo entendimento de "o que este agente esta fazendo".
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ABAS, PENDENCIA_ABA, type AbaId } from "@/lib/ia/abas";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { DESCRICAO_TIPO } from "@/lib/ia/conceitos";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente } from "@/lib/ia/estados";
import { MOCK_TAREFAS } from "@/lib/ia/mocks";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import { Personagem } from "@/components/ia/office/Estacao";
import BadgeEstado from "@/components/ia/BadgeEstado";
import EmBreve from "@/components/ia/EmBreve";
import AbasAgente from "@/components/ia/agente/AbasAgente";
import VisaoGeral from "@/components/ia/agente/VisaoGeral";
import ListaTarefas from "@/components/ia/agente/ListaTarefas";
import AbaConexoes from "@/components/ia/agente/AbaConexoes";
import AbaFuncoes from "@/components/ia/agente/AbaFuncoes";
import AbaPermissoes from "@/components/ia/agente/AbaPermissoes";

export default function PaginaAgente({ agente, aba }: { agente: AgenteUI; aba: AbaId }) {
  const [ancoraMs, setAncoraMs] = useState<number | null>(null);
  const [agoraMs, setAgoraMs] = useState<number | null>(null);

  useEffect(() => {
    const inicio = Date.now();
    setAncoraMs(inicio);
    setAgoraMs(inicio);
    const t = window.setTimeout(() => setAgoraMs(Date.now()), JANELA_CONCLUIDO_MS + 250);
    return () => window.clearTimeout(t);
  }, []);

  const tarefas = useMemo<readonly TarefaUI[]>(
    () => (ancoraMs === null ? [] : MOCK_TAREFAS(ancoraMs).filter((t) => t.agente_id === agente.id)),
    [ancoraMs, agente.id]
  );

  const aparencia = useMemo(
    () => (agoraMs === null ? null : aparenciaDoAgente(agente, tarefas, agoraMs)),
    [agente, tarefas, agoraMs]
  );

  return (
    <>
      <style>{css}</style>

      <p className="cds-ia-volta">
        <Link href="/ia/agentes">← Todos os agentes</Link>
      </p>

      <header className="cds-ia-cabecalho">
        <div className="cds-ia-cabecalho-figura" aria-hidden="true">
          <Personagem
            agente={agente}
            sentado={false}
            apagado={aparencia?.foraDeOperacao ?? false}
            escala={0.9}
          />
        </div>

        <div className="cds-ia-cabecalho-texto">
          <h2 className="cds-ia-nome">{agente.nome}</h2>
          <p className="cds-ia-funcao">
            {DESCRICAO_TIPO[agente.tipo]} · <span className="cds-ia-tipo">{agente.tipo}</span>
          </p>
        </div>

        <div className="cds-ia-cabecalho-estado">
          {aparencia ? (
            <>
              <BadgeEstado aparencia={aparencia} />
              {aparencia.foraDeOperacao && (
                <span className="cds-ia-fora">Este agente está desligado</span>
              )}
            </>
          ) : (
            <span className="cds-ia-carregando">Carregando estado…</span>
          )}
        </div>
      </header>

      <AbasAgente agenteId={agente.id} ativa={aba} />

      <section className="cds-ia-painel" aria-label={rotuloDaAba(aba)}>
        {aba === "visao-geral" && aparencia && (
          <VisaoGeral agente={agente} aparencia={aparencia} tarefas={tarefas} />
        )}

        {aba === "tarefas" && agoraMs !== null && (
          <ListaTarefas tarefas={tarefas} agoraMs={agoraMs} />
        )}

        {(aba === "visao-geral" || aba === "tarefas") && agoraMs === null && (
          <p className="cds-ia-carregando">Carregando…</p>
        )}

        {/* As tres abas de configuracao nao dependem do relogio: elas
            desenham configuracao, nao estado em andamento. */}
        {aba === "conexoes" && <AbaConexoes />}
        {aba === "funcoes" && <AbaFuncoes />}
        {aba === "permissoes" && <AbaPermissoes />}

        {abaPendente(aba) && (
          <EmBreve
            titulo={rotuloDaAba(aba)}
            descricao={DESCRICAO_ABA[aba]}
            pendencia={PENDENCIA_ABA[aba]}
          />
        )}
      </section>
    </>
  );
}

function rotuloDaAba(aba: AbaId): string {
  return ABAS.find((a) => a.id === aba)?.rotulo ?? "Agente";
}

/** Chave de `PENDENCIA_ABA`, derivada da propria lista de abas. */
type AbaPendente = Extract<(typeof ABAS)[number], { implementada: false }>["id"];

/**
 * Predicado com type guard: quem entra aqui e, para o `tsc`, uma aba
 * pendente — e so entao pode indexar `PENDENCIA_ABA`. Promover uma aba a
 * implementada quebra a compilacao se ela continuar na lista de
 * pendencias, em vez de renderizar "Em breve" para algo ja pronto.
 */
function abaPendente(aba: AbaId): aba is AbaPendente {
  return ABAS.find((a) => a.id === aba)?.implementada === false;
}

/** O que cada superficie VAI ser. Fica ao lado da pendencia, para a tela
 *  dizer as duas coisas: o destino e o que falta para chegar la. */
const DESCRICAO_ABA: Record<AbaPendente, string> = {
  chat: "Conversar diretamente com este agente: pedir análises, dar orientações e entender o que ele encontrou.",
  memoria: "Instruções fixas, preferências e o que o agente aprendeu ao longo do tempo.",
  custos: "Consumo de IA deste agente por período, modelo e provedor.",
};

const css = `
  .cds-ia-volta { margin: 0 0 ${ESPACO.md}px; font: 13px/1.4 ${FONTE.interface}; }
  .cds-ia-volta a { color: ${CROMO.textoFraco}; text-decoration: none; }
  .cds-ia-volta a:hover { color: ${CROMO.texto}; }
  .cds-ia-volta a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }

  .cds-ia-cabecalho {
    display: flex; align-items: center; gap: ${ESPACO.lg}px; flex-wrap: wrap;
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-cabecalho-figura { flex-shrink: 0; }
  .cds-ia-cabecalho-texto { flex: 1; min-width: 180px; }
  .cds-ia-cabecalho-estado { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

  .cds-ia-nome { margin: 0; font: 800 20px/1.2 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-funcao { margin: 4px 0 0; font: 13px/1.5 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-tipo { font-family: ${FONTE.palco}; font-size: 12px; }
  .cds-ia-fora { font: 11px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-carregando { font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco}; margin: 0; }

  .cds-ia-painel { padding-top: ${ESPACO.xl}px; }

  @media (max-width: 640px) {
    .cds-ia-cabecalho-estado { align-items: flex-start; width: 100%; }
  }
`;
