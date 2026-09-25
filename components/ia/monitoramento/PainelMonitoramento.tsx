"use client";

/**
 * O painel de monitoramento da ingestao de perguntas — I4P10.
 *
 * ── SOMENTE LEITURA, e visivelmente ────────────────────────────────
 *
 * Nao ha botao de resolver, silenciar, reconhecer ou apagar. O incidente
 * e autoridade do vigia: ele abre a partir de evidencia e fecha a partir
 * de evidencia saudavel. Um botao aqui mentiria duas vezes — daria ao
 * operador a impressao de ter resolvido algo, e o incidente voltaria no
 * minuto seguinte, porque a condicao continua valendo.
 *
 * ── "NENHUM INCIDENTE" NAO E "TUDO CERTO" ───────────────────────────
 *
 * A tela nunca afirma saude. Um monitor que nunca rodou tambem tem zero
 * alertas, e e o pior estado possivel — nao o melhor. Por isso a
 * atividade do vigia aparece SEPARADA dos incidentes, em cima, e o vazio
 * diz o que realmente sabe: que nao ha incidente registrado.
 *
 * ── Erro de leitura nao vira vazio ──────────────────────────────────
 *
 * Os cinco estados sao distintos na tela: carregando, erro de leitura,
 * sem incidentes, monitor nao configurado e atividade desconhecida.
 * Colapsar qualquer par deles faria a tela afirmar mais do que sabe.
 */
import { useEffect, useState } from "react";

import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import type {
  ConfiguracaoParaOperador,
  IncidenteParaOperador,
  MonitorDeUmAgente,
} from "@/lib/agentes/observabilidade/alerta-apresentacao";

interface Resposta {
  readonly ok: boolean;
  readonly incidentes?: readonly IncidenteParaOperador[];
  readonly resolvidos?: readonly IncidenteParaOperador[];
  readonly monitores?: readonly MonitorDeUmAgente[];
}

type Carga =
  | { readonly fase: "carregando" }
  | { readonly fase: "erro" }
  | {
      readonly fase: "pronto";
      readonly incidentes: readonly IncidenteParaOperador[];
      readonly resolvidos: readonly IncidenteParaOperador[];
      readonly monitores: readonly MonitorDeUmAgente[];
    };

/** As tres severidades do dominio, reusando cores que o produto ja tem. */
const COR_DA_SEVERIDADE = {
  critical: CORES_ESTADO.erro,
  alert: CORES_ESTADO.aguardando_aprovacao,
  warning: CORES_ESTADO.ocioso,
} as const;

const NOME_DA_SEVERIDADE = {
  critical: "Crítico",
  alert: "Alerta",
  warning: "Atenção",
} as const;

const NOME_DA_CONFIGURACAO: Readonly<Record<ConfiguracaoParaOperador, string>> = {
  ativo: "Acompanhamento ativo",
  inativo: "Acompanhamento desligado",
  nao_configurado: "Ainda não configurado",
  desconhecido: "Não foi possível ler",
};

function haQuantoTempo(iso: string, agora: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((agora - t) / 1000));
  if (s < 60) return "há menos de um minuto";
  const min = Math.round(s / 60);
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.round(h / 24)} dias`;
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: ESPACO.xxl }}>
      <h2
        style={{
          margin: `0 0 ${ESPACO.md}px`,
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: CROMO.textoFraco,
          font: `800 13px ${FONTE.interface}`,
        }}
      >
        {titulo}
      </h2>
      {children}
    </section>
  );
}

function Aviso({ titulo, descricao }: { titulo: string; descricao: string }) {
  return (
    <div
      role="note"
      style={{
        padding: ESPACO.xl,
        border: `1px dashed ${CROMO.borda}`,
        borderRadius: RAIO.card,
        font: `13px/1.7 ${FONTE.interface}`,
        color: CROMO.textoFraco,
      }}
    >
      <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: CROMO.texto }}>{titulo}</p>
      <p style={{ margin: `${ESPACO.sm}px 0 0`, maxWidth: 560 }}>{descricao}</p>
    </div>
  );
}

function CartaoDoIncidente({
  incidente,
  agora,
}: {
  incidente: IncidenteParaOperador;
  agora: number;
}) {
  const cor = COR_DA_SEVERIDADE[incidente.severidadeAtual];
  const escalou = incidente.severidadeMaxima !== incidente.severidadeAtual;

  return (
    <article
      style={{
        display: "flex",
        gap: ESPACO.md,
        padding: ESPACO.lg,
        background: CROMO.fundoCard,
        border: `1px solid ${CROMO.borda}`,
        borderLeft: `3px solid ${cor}`,
        borderRadius: RAIO.controle,
        font: `13px/1.6 ${FONTE.interface}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: ESPACO.sm, flexWrap: "wrap" }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: CROMO.texto }}>
            {incidente.titulo}
          </span>
          <span style={{ fontSize: 11, fontWeight: 800, color: cor, textTransform: "uppercase" }}>
            {NOME_DA_SEVERIDADE[incidente.severidadeAtual]}
          </span>
        </div>

        <p style={{ margin: `${ESPACO.xs}px 0 0`, color: CROMO.textoFraco }}>
          {incidente.causaTitulo ?? incidente.explicacao}
        </p>

        <p style={{ margin: `${ESPACO.sm}px 0 0`, color: CROMO.textoFraco, fontSize: 12 }}>
          Aberto {haQuantoTempo(incidente.abertoEm, agora)} · visto pela última vez{" "}
          {haQuantoTempo(incidente.ultimoVistoEm, agora)}
          {incidente.ocorrencias > 1 ? ` · ${incidente.ocorrencias} evidências` : ""}
          {escalou ? ` · já chegou a ${NOME_DA_SEVERIDADE[incidente.severidadeMaxima]}` : ""}
        </p>

        {(incidente.janela !== null || incidente.causaAtual !== null) && (
          <p
            style={{
              margin: `${ESPACO.sm}px 0 0`,
              color: CROMO.textoFraco,
              fontSize: 11,
              opacity: 0.8,
            }}
          >
            {incidente.causaAtual !== null ? `${incidente.tipo}/${incidente.causaAtual}` : incidente.tipo}
            {incidente.janela !== null ? ` · janela ${incidente.janela}` : ""}
            {incidente.sequencia !== null ? ` · ${incidente.sequencia} janelas seguidas` : ""}
          </p>
        )}
      </div>
    </article>
  );
}

function BlocoDoMonitor({ monitor, agora }: { monitor: MonitorDeUmAgente; agora: number }) {
  const atividade = monitor.atividade;

  return (
    <div
      style={{
        padding: ESPACO.lg,
        background: CROMO.fundoCard,
        border: `1px solid ${CROMO.borda}`,
        borderRadius: RAIO.controle,
        font: `13px/1.6 ${FONTE.interface}`,
        color: CROMO.textoFraco,
      }}
    >
      <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: CROMO.texto }}>
        {NOME_DA_CONFIGURACAO[monitor.configuracao]}
      </p>

      <p style={{ margin: `${ESPACO.xs}px 0 0` }}>
        {atividade.estado === "observada"
          ? `Última passagem do monitor ${haQuantoTempo(atividade.adquiridaEm, agora)}.`
          : atividade.estado === "nunca_observada"
            ? "O monitor ainda não passou por aqui nenhuma vez."
            : "Não foi possível saber quando o monitor passou."}
      </p>

      {/* O que o lease prova, e o que ele nao prova. Dizer isso na tela
          evita a leitura mais tentadora e mais errada: "o monitor rodou,
          logo a ingestao esta bem". */}
      <p style={{ margin: `${ESPACO.sm}px 0 0`, fontSize: 11, opacity: 0.8 }}>
        Isso indica que o monitor executou — não que o agendador ou a captura de perguntas
        estejam funcionando.
      </p>
    </div>
  );
}

export default function PainelMonitoramento() {
  const [carga, setCarga] = useState<Carga>({ fase: "carregando" });
  const [agora, setAgora] = useState<number>(() => Date.now());

  useEffect(() => {
    let ativo = true;

    // Somente GET. Esta tela nao escreve em lugar nenhum — ver o
    // cabecalho.
    fetch("/api/agentes/observabilidade")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("leitura"))))
      .then((dados: Resposta) => {
        if (!ativo) return;
        if (!dados.ok) {
          setCarga({ fase: "erro" });
          return;
        }
        setAgora(Date.now());
        setCarga({
          fase: "pronto",
          incidentes: dados.incidentes ?? [],
          resolvidos: dados.resolvidos ?? [],
          monitores: dados.monitores ?? [],
        });
      })
      .catch(() => {
        if (!ativo) return;
        // Falha de leitura NAO vira "nenhum alerta".
        setCarga({ fase: "erro" });
      });

    return () => {
      ativo = false;
    };
  }, []);

  if (carga.fase === "carregando") {
    return <Aviso titulo="Carregando…" descricao="Lendo o monitoramento da ingestão de perguntas." />;
  }

  if (carga.fase === "erro") {
    return (
      <Aviso
        titulo="Não foi possível ler o monitoramento"
        descricao="A leitura falhou. Isto não quer dizer que não há incidentes — quer dizer que não conseguimos verificar."
      />
    );
  }

  return (
    <div>
      <Secao titulo="Monitor">
        {carga.monitores.length === 0 ? (
          <Aviso
            titulo="Monitor ainda não configurado"
            descricao="Ninguém declarou se a ingestão de perguntas deveria estar sendo acompanhada, e o monitor ainda não passou por aqui."
          />
        ) : (
          <div style={{ display: "grid", gap: ESPACO.md }}>
            {carga.monitores.map((m) => (
              <BlocoDoMonitor key={m.agenteId} monitor={m} agora={agora} />
            ))}
          </div>
        )}
      </Secao>

      <Secao titulo="Incidentes abertos">
        {carga.incidentes.length === 0 ? (
          <Aviso
            titulo="Nenhum incidente aberto"
            descricao="Não há incidente registrado agora. Isso não é o mesmo que estar tudo certo: veja acima quando o monitor passou pela última vez."
          />
        ) : (
          <div style={{ display: "grid", gap: ESPACO.md }}>
            {carga.incidentes.map((i) => (
              <CartaoDoIncidente key={i.id} incidente={i} agora={agora} />
            ))}
          </div>
        )}
      </Secao>

      {carga.resolvidos.length > 0 && (
        <Secao titulo="Resolvidos recentemente">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ESPACO.sm }}>
            {carga.resolvidos.map((i) => (
              <li
                key={i.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: ESPACO.md,
                  padding: `${ESPACO.sm}px ${ESPACO.md}px`,
                  border: `1px solid ${CROMO.bordaSutil}`,
                  borderRadius: RAIO.controle,
                  font: `12px/1.6 ${FONTE.interface}`,
                  color: CROMO.textoFraco,
                }}
              >
                <span style={{ color: CROMO.texto }}>{i.titulo}</span>
                <span>
                  {i.resolvidoEm !== null ? `resolvido ${haQuantoTempo(i.resolvidoEm, agora)}` : "—"}
                </span>
              </li>
            ))}
          </ul>
        </Secao>
      )}
    </div>
  );
}
