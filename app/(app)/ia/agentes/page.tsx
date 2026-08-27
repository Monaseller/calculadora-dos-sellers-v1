"use client";

/**
 * `/ia/agentes` — a lista de agentes.
 *
 * ── Duas funcoes, nao uma ───────────────────────────────────────────
 *
 * 1. E a lista propriamente dita, com clique para o resumo do agente.
 * 2. E a REPRESENTACAO ADAPTADA do escritorio para telas estreitas. O
 *    palco pixel art some abaixo de 720px e aponta para ca; a informacao
 *    e a mesma (quem e, como esta, o que faz, quanto avancou), so a
 *    forma muda. Espremer o mapa em 375px nao o tornaria util.
 *
 * Por isso ela usa exatamente o mesmo vocabulario de estado e o mesmo
 * drawer — nao existe uma "versao mobile" com regras proprias.
 */
import { useEffect, useMemo, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente, rotuloDe } from "@/lib/ia/estados";
import { MOCK_AGENTES, MOCK_TAREFAS } from "@/lib/ia/mocks";
import type { TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado, { corDaAparencia } from "@/components/ia/BadgeEstado";
import PainelAgente from "@/components/ia/office/PainelAgente";

export default function PaginaAgentes() {
  // `ancoraMs` fixa os dados; `agoraMs` anda e faz o flash expirar. Ver
  // o cabecalho de `Escritorio.tsx`: juntar os dois tornava permanente um
  // estado que existe justamente para ser temporario.
  const [ancoraMs, setAncoraMs] = useState<number | null>(null);
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);

  // Tambem evita divergencia de hidratacao: ler o relogio no servidor e
  // no cliente produziria HTML diferente nos dois lados.
  useEffect(() => {
    const inicio = Date.now();
    setAncoraMs(inicio);
    setAgoraMs(inicio);
    const t = window.setTimeout(() => setAgoraMs(Date.now()), JANELA_CONCLUIDO_MS + 250);
    return () => window.clearTimeout(t);
  }, []);

  const tarefas = useMemo<readonly TarefaUI[]>(
    () => (ancoraMs === null ? [] : MOCK_TAREFAS(ancoraMs)),
    [ancoraMs]
  );

  const linhas = useMemo(() => {
    if (agoraMs === null) return [];
    return MOCK_AGENTES.map((agente) => {
      const doAgente = tarefas.filter((t) => t.agente_id === agente.id);
      return {
        agente,
        aparencia: aparenciaDoAgente(agente, doAgente, agoraMs),
        tarefa: doAgente.find((t) => t.concluido_em === null) ?? null,
      };
    });
  }, [tarefas, agoraMs]);

  const aberto = linhas.find((l) => l.agente.id === selecionado) ?? null;

  if (agoraMs === null) {
    return <p style={{ color: CROMO.textoFraco, font: `13px/1.6 ${FONTE.interface}` }}>Carregando…</p>;
  }

  return (
    <>
      <style>{css}</style>

      <ul className="cds-ia-lista">
        {linhas.map(({ agente, aparencia, tarefa }) => (
          <li key={agente.id}>
            <button
              type="button"
              onClick={() => setSelecionado(agente.id)}
              className="cds-ia-card"
              aria-label={`${agente.nome}, ${rotuloDe(aparencia)}${
                tarefa ? `, ${tarefa.titulo}` : ""
              }. Abrir detalhes.`}
            >
              <div style={{ display: "flex", alignItems: "center", gap: ESPACO.md, width: "100%" }}>
                <div
                  aria-hidden="true"
                  style={{
                    width: 34,
                    height: 34,
                    flexShrink: 0,
                    display: "grid",
                    placeItems: "center",
                    borderRadius: RAIO.controle,
                    border: `1px solid ${CROMO.borda}`,
                    background: "rgba(255,255,255,0.04)",
                    color: corDaAparencia(aparencia),
                    font: `800 14px/1 ${FONTE.interface}`,
                  }}
                >
                  {agente.nome.charAt(0).toUpperCase()}
                </div>

                <div style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: CROMO.texto }}>
                    {agente.nome}
                  </div>
                  <div style={{ fontSize: 12, color: CROMO.textoFraco }}>{agente.tipo}</div>
                </div>

                <BadgeEstado aparencia={aparencia} />
              </div>

              <div style={{ width: "100%", textAlign: "left" }}>
                <p style={{ margin: `${ESPACO.md}px 0 0`, fontSize: 13, color: CROMO.textoFraco }}>
                  {tarefa ? tarefa.titulo : "Nenhuma tarefa em andamento."}
                </p>

                {tarefa && tarefa.progresso > 0 && (
                  <div
                    role="progressbar"
                    aria-valuenow={tarefa.progresso}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Progresso de ${agente.nome}`}
                    style={{
                      marginTop: ESPACO.sm,
                      height: 8,
                      background: "rgba(255,255,255,0.06)",
                      borderRadius: 999,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        width: `${tarefa.progresso}%`,
                        height: "100%",
                        background: corDaAparencia(aparencia),
                      }}
                    />
                  </div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {aberto && (
        <PainelAgente
          agente={aberto.agente}
          aparencia={aberto.aparencia}
          tarefas={tarefas.filter((t) => t.agente_id === aberto.agente.id)}
          onFechar={() => setSelecionado(null)}
        />
      )}
    </>
  );
}

const css = `
  .cds-ia-lista {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .cds-ia-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 100%;
    padding: 16px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    cursor: pointer;
    font: inherit;
    color: inherit;
    text-align: left;
    transition: background .15s;
  }
  .cds-ia-card:hover { background: ${CROMO.fundoCardHover}; }
  .cds-ia-card:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .cds-ia-card { transition: none; }
  }
`;
