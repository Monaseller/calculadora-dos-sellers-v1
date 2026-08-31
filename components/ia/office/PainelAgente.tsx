"use client";

/**
 * Drawer de resumo do agente.
 *
 * ── O que este componente NAO deve virar ────────────────────────────
 *
 * A pagina definitiva do agente existe agora, em `/ia/agentes/[id]`, com
 * as oito abas. Este drawer NAO e o lugar delas. Ele responde "o que
 * este agente esta fazendo agora?" em um clique, e deve continuar
 * cabendo nessa frase.
 *
 * Por isso ele mostra identidade, estado, tarefa e progresso — e para.
 * O historico completo de tarefas MOROU aqui por uma fase e saiu: era a
 * aba Tarefas nascendo dentro do drawer. Cada pedaco empurrado para ca
 * torna mais caro manter a pagina real como o lugar da configuracao.
 *
 * Consulta rapida aqui; configuracao e operacao completas la. O caminho
 * entre os dois e o botao "Abrir agente".
 *
 * ── O rodape nao diz mais "Dados simulados" ─────────────────────────
 *
 * Ele dizia, e a frase virou falsa: a identidade e o estado exibidos
 * aqui vem do agente REAL do dono, pela mesma leitura autenticada da
 * lista. O que sobrou de simulado neste drawer nao e dado nenhum — e a
 * ausencia de tarefas, que chega como lista vazia e ja se anuncia
 * sozinha ("Nenhuma tarefa em andamento").
 *
 * A frase de orientacao ficou: ela nao afirma nada sobre procedencia,
 * so diz onde mora o resto.
 *
 * ── Acessibilidade nao e enfeite aqui ───────────────────────────────
 *
 * Um painel que abre e prende o usuario e pior que nao ter painel. Este
 * fecha por Escape e por clique no fundo, devolve o foco a quem o abriu,
 * e leva o foco para dentro ao abrir — senao o leitor de tela continua
 * lendo o escritorio atras do painel.
 */
import { useEffect, useRef } from "react";
import Link from "next/link";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { VOCABULARIO_ESTADO, type AparenciaAgente } from "@/lib/ia/estados";
import { tarefaAtual, tituloDaTarefa } from "@/lib/ia/tarefas";
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

  const atual = tarefaAtual(tarefas);
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
              <p style={{ margin: 0 }}>{tituloDaTarefa(atual)}</p>
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

        {/* O caminho para a configuracao completa. E um <Link> de
            verdade: navega, abre em nova aba, aparece no historico. */}
        <Link
          href={`/ia/agentes/${agente.id}`}
          style={{
            display: "block",
            marginTop: ESPACO.xl,
            padding: "11px 0",
            textAlign: "center",
            textDecoration: "none",
            border: `1px solid ${CROMO.acentoBorda}`,
            borderRadius: RAIO.controle,
            background: CROMO.acentoFundo,
            color: CROMO.acento,
            fontWeight: 700,
            letterSpacing: 0.4,
          }}
        >
          Abrir agente
        </Link>

        <p
          style={{
            marginTop: ESPACO.lg,
            fontSize: 12,
            lineHeight: 1.6,
            color: CROMO.textoFraco,
          }}
        >
          Este painel é consulta rápida — o histórico de tarefas, as conexões, as funções, as
          permissões, a memória e os custos vivem na página do agente.
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
