"use client";

/**
 * O escritorio da CDS IA — home visual da area.
 *
 * ── Layout derivado, nunca coordenada ───────────────────────────────
 *
 * Ha duas zonas, e o ESTADO decide em qual o agente aparece:
 *
 *   estacoes — grid `auto-fit`, para quem esta produzindo;
 *   copa     — para quem esta ocioso ou fora de operacao.
 *
 * Nenhum agente carrega `x`/`y`. Acrescentar o vigesimo agente nao exige
 * tocar em codigo: o grid reflui. E a mudanca de zona ja e, sozinha, a
 * leitura de "levantou da mesa" — sem engine, sem canvas, sem fisica.
 *
 * Quando quisermos a caminhada de verdade, ela entra como transicao de
 * `transform` entre as duas zonas. A estrutura ja permite; e por isso que
 * a posicao nao esta congelada em constante nenhuma.
 *
 * ── Por que `agoraMs` vem do cliente, e nao do render ───────────────
 *
 * `concluido` e transitorio: depende de comparar `concluido_em` com o
 * relogio. Ler o relogio durante o SSR e de novo no cliente produziria
 * HTML diferente nos dois lados — erro de hidratacao. Entao o palco so
 * desenha depois da montagem, com um unico `Date.now()`.
 */
import { useEffect, useMemo, useState } from "react";
import { BREAKPOINT, CROMO, ESPACO, FONTE, PALCO, RAIO, degrau } from "@/lib/ia/design";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente, estaNaEstacao, rotuloDe } from "@/lib/ia/estados";
import { MOCK_AGENTES, MOCK_TAREFAS } from "@/lib/ia/mocks";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import Estacao, { Personagem } from "@/components/ia/office/Estacao";
import PainelAgente from "@/components/ia/office/PainelAgente";
import BadgeEstado from "@/components/ia/BadgeEstado";

export default function Escritorio() {
  // DOIS relogios, e a diferenca importa:
  //   `ancoraMs` — instante da montagem. Gera as tarefas UMA vez e nunca
  //                mais muda. Sao os "dados", que no mundo real viriam do
  //                banco e nao se reescrevem sozinhos.
  //   `agoraMs`  — avanca. E o que faz o flash de conclusao expirar.
  //
  // Juntar os dois numa variavel so foi um bug real: as tarefas eram
  // regeradas relativas ao novo instante, a tarefa encerrada continuava
  // "ha 2 segundos" para sempre e o estado transitorio nunca terminava.
  const [ancoraMs, setAncoraMs] = useState<number | null>(null);
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);

  useEffect(() => {
    const inicio = Date.now();
    setAncoraMs(inicio);
    setAgoraMs(inicio);
    // Um unico reagendamento, logo depois do fim da janela: e o instante
    // exato em que a tela precisa mudar sozinha. Um `setInterval` de 1s
    // redesenharia o palco oito vezes para o mesmo resultado. A margem
    // evita cair no limite exato da comparacao.
    const t = window.setTimeout(() => setAgoraMs(Date.now()), JANELA_CONCLUIDO_MS + 250);
    return () => window.clearTimeout(t);
  }, []);

  const tarefas = useMemo<readonly TarefaUI[]>(
    () => (ancoraMs === null ? [] : MOCK_TAREFAS(ancoraMs)),
    [ancoraMs]
  );

  const comAparencia = useMemo(() => {
    if (agoraMs === null) return [];
    return MOCK_AGENTES.map((agente) => {
      const doAgente = tarefas.filter((t) => t.agente_id === agente.id);
      const aparencia = aparenciaDoAgente(agente, doAgente, agoraMs);
      // A tarefa que a estacao mostra e a que NAO terminou. Uma tarefa
      // concluida ha 2s ainda pinta o flash, mas nao deve reaparecer
      // como "tarefa atual" na mesa.
      const atual = doAgente.find((t) => t.concluido_em === null) ?? null;
      return { agente, aparencia, tarefa: atual };
    });
  }, [tarefas, agoraMs]);

  const naEstacao = comAparencia.filter((a) => estaNaEstacao(a.aparencia));
  const naCopa = comAparencia.filter((a) => !estaNaEstacao(a.aparencia));
  const aberto = comAparencia.find((a) => a.agente.id === selecionado) ?? null;

  return (
    <>
      <style>{css}</style>

      {/* Abaixo do minimo, o palco nao e espremido: some e da lugar ao
          convite para a lista, que e a representacao adaptada. Decisao
          por CSS, nao por JS — sem listener de resize, sem hidratacao
          divergente. */}
      <div className="cds-ia-fallback" role="note">
        <strong style={{ display: "block", marginBottom: 6 }}>Escritório indisponível nesta largura</strong>
        O mapa do escritório precisa de mais espaço para ser legível. Use a{" "}
        <a href="/ia/agentes" style={{ color: CROMO.acento }}>lista de agentes</a>, que mostra a
        mesma informação.
      </div>

      <div className="cds-ia-palco">
        {/* Parede */}
        <div style={estilos.parede}>
          <div style={estilos.janela} />
          <div style={{ ...estilos.janela, left: "auto", right: "8%" }} />
        </div>

        {/* Piso */}
        <div style={estilos.piso}>
          {agoraMs === null ? (
            <p style={estilos.carregando}>Montando o escritório…</p>
          ) : (
            <div className="cds-ia-zonas">
              <section aria-label="Estações de trabalho" style={{ minWidth: 0 }}>
                <h2 style={estilos.tituloZona}>ESTAÇÕES</h2>
                {naEstacao.length === 0 ? (
                  <p style={estilos.zonaVazia}>Nenhum agente trabalhando agora.</p>
                ) : (
                  <div className="cds-ia-grade">
                    {naEstacao.map(({ agente, aparencia, tarefa }) => (
                      <Estacao
                        key={agente.id}
                        agente={agente}
                        aparencia={aparencia}
                        tarefa={tarefa}
                        onSelecionar={() => setSelecionado(agente.id)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section aria-label="Copa" style={estilos.copa}>
                <h2 style={{ ...estilos.tituloZona, textAlign: "center" }}>CAFÉ</h2>
                <div style={estilos.maquina} aria-hidden="true" />
                <div style={estilos.mesaRedonda} aria-hidden="true" />
                <div style={estilos.copaAgentes}>
                  {naCopa.map(({ agente, aparencia }) => (
                    <AgenteNaCopa
                      key={agente.id}
                      agente={agente}
                      apagado={aparencia.foraDeOperacao}
                      rotulo={rotuloDe(aparencia)}
                      onSelecionar={() => setSelecionado(agente.id)}
                    >
                      <BadgeEstado aparencia={aparencia} variante="palco" />
                    </AgenteNaCopa>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>

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

/**
 * Agente na copa: em pe, menor, sem mesa.
 *
 * E um `<button>` de verdade — o prototipo usava `<span>` em alguns
 * pontos clicaveis, o que tira teclado e leitor de tela do jogo.
 */
function AgenteNaCopa({
  agente,
  apagado,
  rotulo,
  onSelecionar,
  children,
}: {
  agente: AgenteUI;
  apagado: boolean;
  rotulo: string;
  onSelecionar: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelecionar}
      className="cds-ia-estacao"
      aria-label={`${agente.nome}, ${rotulo}. Abrir detalhes.`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        padding: 6,
        background: "none",
        border: "none",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <Personagem agente={agente} sentado={false} apagado={apagado} escala={0.8} />
      <span
        style={{
          font: `700 10px/1.3 ${FONTE.palco}`,
          color: apagado ? "#7c8698" : "#e8ecf3",
          textShadow: `1px 1px 0 ${PALCO.linha}`,
        }}
      >
        {agente.nome}
      </span>
      {children}
    </button>
  );
}

const estilos: Record<string, React.CSSProperties> = {
  parede: {
    position: "relative",
    height: 96,
    background: `linear-gradient(180deg, ${PALCO.parede} 0%, ${PALCO.paredeEscura} 100%)`,
    borderBottom: `6px solid ${PALCO.rodape}`,
  },
  janela: {
    position: "absolute",
    left: "8%",
    top: 18,
    width: 120,
    height: 58,
    background: "linear-gradient(180deg,#6fb3e0 0%,#8fd0ea 100%)",
    border: `4px solid ${PALCO.rodape}`,
    boxShadow: degrau(),
  },
  piso: {
    padding: ESPACO.xl,
    minHeight: 380,
    backgroundColor: PALCO.pisoA,
    backgroundImage: `linear-gradient(45deg,${PALCO.pisoB} 25%,transparent 25%,transparent 75%,${PALCO.pisoB} 75%),linear-gradient(45deg,${PALCO.pisoB} 25%,transparent 25%,transparent 75%,${PALCO.pisoB} 75%)`,
    backgroundSize: "48px 48px",
    backgroundPosition: "0 0, 24px 24px",
  },
  tituloZona: {
    margin: `0 0 ${ESPACO.md}px`,
    font: `700 10px/1 ${FONTE.palco}`,
    letterSpacing: 2,
    color: "#3b3227",
  },
  zonaVazia: {
    margin: 0,
    font: `12px/1.5 ${FONTE.palco}`,
    color: "#4a4033",
  },
  copa: {
    background: PALCO.copa,
    border: `4px solid ${PALCO.rodape}`,
    boxShadow: degrau(),
    borderRadius: RAIO.palco,
    padding: ESPACO.md,
    alignSelf: "start",
  },
  maquina: {
    margin: "0 auto",
    width: 40,
    height: 52,
    background: "#2c3a52",
    border: `3px solid ${PALCO.rodape}`,
    boxShadow: "inset 0 -14px 0 0 #6b4a2f",
  },
  mesaRedonda: {
    margin: `${ESPACO.md}px auto 0`,
    width: 74,
    height: 36,
    background: PALCO.mesaTopo,
    border: `3px solid ${PALCO.rodape}`,
    boxShadow: degrau(),
  },
  copaAgentes: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: ESPACO.sm,
    marginTop: ESPACO.md,
  },
  carregando: {
    margin: 0,
    font: `12px/1.5 ${FONTE.palco}`,
    color: "#4a4033",
  },
};

/**
 * O CSS que `style={{}}` nao alcanca: pseudo-classes, animacoes, media
 * queries. Mesmo recurso que o prototipo usa, pelo mesmo motivo.
 *
 * `prefers-reduced-motion` desliga PISCAR e PULSAR por completo — nao os
 * deixa mais lentos. Movimento repetitivo e gatilho vestibular, e o
 * estado continua legivel pelo icone, pelo texto e pela cor.
 */
const css = `
  .cds-ia-palco { display: block; }
  .cds-ia-fallback { display: none; }

  .cds-ia-zonas {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 190px;
    gap: 24px;
    align-items: start;
  }
  .cds-ia-grade {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 16px;
  }

  .cds-ia-estacao { transition: transform .08s steps(2); }
  .cds-ia-estacao:hover { transform: translateY(-3px); }
  .cds-ia-estacao:focus-visible { outline: 3px solid #4fd1c5; outline-offset: 4px; }

  .cds-ia-piscando { animation: cds-ia-piscar 1s steps(2, jump-none) infinite; }
  @keyframes cds-ia-piscar { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

  .cds-ia-pulso { animation: cds-ia-pulsar 1.2s steps(2, jump-none) infinite; }
  @keyframes cds-ia-pulsar { 0%,100% { opacity: 1 } 50% { opacity: .2 } }

  @media (max-width: ${BREAKPOINT.tablet}px) {
    .cds-ia-zonas { grid-template-columns: minmax(0, 1fr); }
  }

  @media (max-width: ${BREAKPOINT.palcoMinimo}px) {
    .cds-ia-palco { display: none; }
    .cds-ia-fallback {
      display: block;
      padding: 20px;
      border: 1px solid ${CROMO.borda};
      border-radius: ${RAIO.card}px;
      background: ${CROMO.fundoCard};
      color: ${CROMO.textoFraco};
      font: 13px/1.6 ${FONTE.interface};
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .cds-ia-estacao { transition: none; }
    .cds-ia-estacao:hover { transform: none; }
    .cds-ia-piscando, .cds-ia-pulso { animation: none; }
  }
`;
