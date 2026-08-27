/**
 * Uma estacao do escritorio: mesa, monitor, agente sentado, progresso.
 *
 * ── O que mudou em relacao ao prototipo ─────────────────────────────
 *
 * O prototipo posicionava cada estacao com `left: 14%` / `top: 30%`
 * vindos de constantes por agente. Aqui a estacao NAO sabe onde esta:
 * ela e um item de grid e o pai decide o arranjo. E o que permite passar
 * de 6 para 20 agentes sem tocar neste arquivo.
 *
 * A estacao tambem nao sabe traduzir estado: recebe `aparencia` ja
 * resolvida por `lib/ia/estados.ts`. As palavras "ocupado" e "idle" nao
 * existem neste arquivo, nem podem existir.
 */
import { CORES_TIPO, FONTE, PALCO, RAIO, degrau } from "@/lib/ia/design";
import { VOCABULARIO_ESTADO, type AparenciaAgente } from "@/lib/ia/estados";
import { tituloDaTarefa } from "@/lib/ia/tarefas";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado, { corDaAparencia } from "@/components/ia/BadgeEstado";

/**
 * Personagem geometrico: cabeca + tronco. Exportado porque a copa
 * desenha o mesmo agente em pe — uma definicao so, dois lugares.
 *
 * `sentado` encurta o tronco e desce a figura: e a diferenca entre
 * "trabalhando na mesa" e "circulando", sem sprite e sem animacao.
 */
export function Personagem({
  agente,
  sentado,
  apagado,
  escala = 1,
}: {
  agente: AgenteUI;
  sentado: boolean;
  apagado: boolean;
  escala?: number;
}) {
  const cor = apagado ? "#57606f" : CORES_TIPO[agente.tipo];
  const px = (n: number) => Math.round(n * escala);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity: apagado ? 0.45 : 1,
        filter: apagado ? "saturate(0.25)" : "none",
      }}
    >
      <div
        style={{
          width: px(30),
          height: px(30),
          display: "grid",
          placeItems: "center",
          background: cor,
          border: `3px solid ${PALCO.linha}`,
          borderRadius: RAIO.palco,
          color: PALCO.linha,
          font: `700 ${px(14)}px/1 ${FONTE.palco}`,
        }}
      >
        {agente.nome.charAt(0).toUpperCase()}
      </div>
      <div
        style={{
          width: px(40),
          height: px(sentado ? 18 : 26),
          marginTop: -2,
          background: cor,
          border: `3px solid ${PALCO.linha}`,
          borderTop: "none",
          borderRadius: RAIO.palco,
          opacity: 0.9,
        }}
      />
    </div>
  );
}

export default function Estacao({
  agente,
  aparencia,
  tarefa,
  onSelecionar,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  tarefa: TarefaUI | null;
  onSelecionar: () => void;
}) {
  const cor = corDaAparencia(aparencia);
  const trabalhando = aparencia.estado === "trabalhando";
  const alerta = aparencia.estado === "erro" || aparencia.estado === "aguardando_aprovacao";
  const progresso = tarefa?.progresso ?? 0;

  return (
    <button
      type="button"
      onClick={onSelecionar}
      className="cds-ia-estacao"
      // O <button> ja anuncia o papel; o aria-label carrega o que a tela
      // mostra visualmente em tres pedacos separados (nome, estado,
      // tarefa) e que um leitor de tela leria fora de ordem.
      aria-label={`${agente.nome}, ${VOCABULARIO_ESTADO[aparencia.estado].rotulo}${
        tarefa ? `, ${tituloDaTarefa(tarefa)}` : ""
      }. Abrir detalhes.`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: 8,
        margin: 0,
        background: "none",
        border: "none",
        borderRadius: RAIO.palco,
        cursor: "pointer",
        font: "inherit",
        color: PALCO.linha,
      }}
    >
      <BadgeEstado aparencia={aparencia} variante="palco" />

      {/* Luz de alerta: fica sobre a mesa, some quando nao ha alerta. */}
      <div
        aria-hidden="true"
        className={aparencia.estado === "aguardando_aprovacao" ? "cds-ia-pulso" : undefined}
        style={{
          width: 10,
          height: 10,
          background: alerta ? cor : "transparent",
          border: alerta ? `2px solid ${PALCO.linha}` : "2px solid transparent",
        }}
      />

      <Personagem agente={agente} sentado apagado={aparencia.foraDeOperacao} />

      {/* Mesa */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginTop: -6 }}>
        <div
          style={{
            width: 116,
            height: 30,
            display: "grid",
            placeItems: "center",
            background: PALCO.mesaTopo,
            border: `3px solid ${PALCO.linha}`,
            boxShadow: degrau(),
          }}
        >
          <div
            style={{
              width: 44,
              height: 20,
              padding: 2,
              background: PALCO.monitor,
              border: `2px solid ${PALCO.linha}`,
              boxShadow: trabalhando ? `0 0 0 2px ${cor}` : "none",
            }}
          >
            <div
              className={trabalhando ? "cds-ia-piscando" : undefined}
              style={{
                width: "100%",
                height: "100%",
                background: aparencia.foraDeOperacao ? PALCO.monitorApagado : cor,
              }}
            />
          </div>
        </div>
        <div
          style={{
            width: 88,
            height: 12,
            background: PALCO.mesa,
            border: `3px solid ${PALCO.linha}`,
            borderTop: "none",
          }}
        />
      </div>

      <div
        style={{
          marginTop: 4,
          font: `700 11px/1.3 ${FONTE.palco}`,
          color: "#e8ecf3",
          textShadow: `1px 1px 0 ${PALCO.linha}`,
          textAlign: "center",
        }}
      >
        {agente.nome}
      </div>

      {/* Progresso so aparece quando ha tarefa em andamento com avanco.
          Barra de 0% e ruido: nao informa nada e polui o palco. */}
      {progresso > 0 && (
        <div
          style={{
            width: 96,
            height: 8,
            background: PALCO.rodape,
            border: `2px solid ${PALCO.linha}`,
          }}
          role="progressbar"
          aria-valuenow={progresso}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progresso de ${agente.nome}`}
        >
          <div style={{ width: `${progresso}%`, height: "100%", background: cor }} />
        </div>
      )}
    </button>
  );
}
