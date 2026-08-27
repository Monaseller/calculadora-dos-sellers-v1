"use client";

/**
 * Drawer de resumo do agente.
 *
 * ── O que este componente NAO deve virar ────────────────────────────
 *
 * A pagina definitiva do agente tera oito abas (Visao geral, Chat,
 * Tarefas, Conexoes, Funcoes, Permissoes, Memoria, Custos). Este drawer
 * NAO e o lugar delas. Ele existe para responder "o que este agente esta
 * fazendo agora?" em um clique, e deve continuar cabendo nessa frase.
 *
 * Por isso ele mostra identidade, estado, tarefa e progresso — e para.
 * Cada aba que for empurrada para ca torna mais caro extrair a pagina
 * real depois, ate que ninguem extraia.
 *
 * ── Acessibilidade nao e enfeite aqui ───────────────────────────────
 *
 * Um painel que abre e prende o usuario e pior que nao ter painel. Este
 * fecha por Escape e por clique no fundo, devolve o foco a quem o abriu,
 * e leva o foco para dentro ao abrir — senao o leitor de tela continua
 * lendo o escritorio atras do painel.
 */
import { useEffect, useRef } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { VOCABULARIO_ESTADO, type AparenciaAgente } from "@/lib/ia/estados";
import { MOCK_AVISO } from "@/lib/ia/mocks";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado, { corDaAparencia } from "@/components/ia/BadgeEstado";

export default function PainelAgente({
  agente,
  aparencia,
  tarefas,
  onFechar,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  tarefas: readonly TarefaUI[];
  onFechar: () => void;
}) {
  const fecharRef = useRef<HTMLButtonElement | null>(null);
  const tituloId = `cds-ia-painel-${agente.id}`;

  useEffect(() => {
    // Guardado no efeito, nao no render: aqui o elemento ativo ainda e
    // quem disparou a abertura.
    const anterior = document.activeElement as HTMLElement | null;
    fecharRef.current?.focus();

    function aoTeclar(evento: KeyboardEvent) {
      if (evento.key === "Escape") {
        evento.stopPropagation();
        onFechar();
      }
    }
    document.addEventListener("keydown", aoTeclar);

    return () => {
      document.removeEventListener("keydown", aoTeclar);
      // `isConnected`: se o gatilho saiu do DOM enquanto o painel estava
      // aberto, devolver foco a ele jogaria o foco para o `<body>`.
      if (anterior && anterior.isConnected) anterior.focus();
    };
  }, [onFechar]);

  const atual = tarefas.find((t) => t.concluido_em === null) ?? null;
  const cor = corDaAparencia(aparencia);

  return (
    <>
      <div
        onClick={onFechar}
        // O fundo e atalho de mouse para uma acao que ja existe no botao
        // Fechar. Para teclado ele seria so mais uma parada inutil.
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, background: "#000", opacity: 0.55, zIndex: 50 }}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(360px, 100vw)",
          zIndex: 51,
          background: CROMO.fundo,
          borderLeft: `1px solid ${CROMO.borda}`,
          padding: ESPACO.xl,
          overflowY: "auto",
          font: `13px/1.6 ${FONTE.interface}`,
          color: CROMO.texto,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: ESPACO.md }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 id={tituloId} style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>
              {agente.nome}
            </h2>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: CROMO.textoFraco }}>
              Tipo: {agente.tipo}
            </p>
          </div>
          <button
            ref={fecharRef}
            type="button"
            onClick={onFechar}
            aria-label="Fechar painel do agente"
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              background: "none",
              border: `1px solid ${CROMO.borda}`,
              borderRadius: RAIO.controle,
              color: CROMO.textoFraco,
              cursor: "pointer",
              font: "inherit",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <Campo rotulo="ESTADO">
          <BadgeEstado aparencia={aparencia} />
          {aparencia.foraDeOperacao && (
            <p style={{ margin: `${ESPACO.sm}px 0 0`, fontSize: 12, color: CROMO.textoFraco }}>
              Este agente está desligado. O histórico dele é preservado, e nenhuma tarefa
              antiga altera o estado exibido.
            </p>
          )}
        </Campo>

        <Campo rotulo="TAREFA ATUAL">
          {atual ? (
            <>
              <p style={{ margin: 0 }}>{atual.titulo}</p>
              <div
                role="progressbar"
                aria-valuenow={atual.progresso}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Progresso: ${atual.progresso} por cento`}
                style={{
                  marginTop: ESPACO.sm,
                  height: 10,
                  background: "rgba(255,255,255,0.06)",
                  borderRadius: 999,
                  overflow: "hidden",
                }}
              >
                <div style={{ width: `${atual.progresso}%`, height: "100%", background: cor }} />
              </div>
              <p style={{ margin: `${ESPACO.xs}px 0 0`, fontSize: 12, color: CROMO.textoFraco }}>
                {atual.progresso}% — {VOCABULARIO_ESTADO[aparencia.estado].rotulo}
              </p>
            </>
          ) : (
            <p style={{ margin: 0, color: CROMO.textoFraco }}>Nenhuma tarefa em andamento.</p>
          )}
        </Campo>

        <Campo rotulo="HISTÓRICO">
          {tarefas.length === 0 ? (
            <p style={{ margin: 0, color: CROMO.textoFraco }}>Nenhuma tarefa registrada.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, color: CROMO.textoFraco }}>
              {tarefas.map((t) => (
                <li key={t.id} style={{ marginBottom: 4 }}>
                  {t.titulo} — {t.status}
                </li>
              ))}
            </ul>
          )}
        </Campo>

        <p
          style={{
            marginTop: ESPACO.xl,
            padding: ESPACO.md,
            border: `1px solid ${CROMO.borda}`,
            borderRadius: RAIO.controle,
            fontSize: 12,
            color: CROMO.textoFraco,
          }}
        >
          {MOCK_AVISO}. A página completa do agente — visão geral, chat, tarefas, conexões,
          funções, permissões, memória e custos — chega em fase posterior.
        </p>
      </aside>
    </>
  );
}

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: ESPACO.xl }}>
      <div
        style={{
          marginBottom: ESPACO.sm,
          fontSize: 10,
          letterSpacing: 2,
          color: CROMO.textoFraco,
        }}
      >
        {rotulo}
      </div>
      {children}
    </div>
  );
}
