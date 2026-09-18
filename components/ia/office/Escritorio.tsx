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
 *
 * ── O palco deixou de ser simulado ──────────────────────────────────
 *
 * Ele desenhava `MOCK_AGENTES` e `MOCK_TAREFAS`. Agora le os agentes
 * REAIS do dono e o snapshot operacional de cada um, pela mesma rota
 * autenticada que a lista de agentes usa.
 *
 * O que chega NAO e tarefa: sao `sinais` (status + `concluido_em`) e a
 * `atividade` ja resumida pelo servidor. A derivacao de estado continua
 * inteira do lado do cliente, com `aparenciaDoAgente` — e assim o flash
 * de concluido expira com o relogio de quem olha, sem depender de
 * nenhuma resposta nova.
 *
 * ── O refresh nao e `setInterval` ───────────────────────────────────
 *
 * E `await` seguido de `setTimeout`: o proximo ciclo so e agendado
 * quando o anterior TERMINA. Um intervalo fixo enfileira requisicoes
 * quando a rede fica lenta, e a tela passa a aplicar respostas fora de
 * ordem — o palco piscaria entre dois retratos diferentes.
 */
import { useEffect, useMemo, useState } from "react";
import { BREAKPOINT, CROMO, ESPACO, FONTE, PALCO, RAIO, degrau } from "@/lib/ia/design";
import {
  JANELA_CONCLUIDO_MS,
  aparenciaDoAgente,
  estaNaEstacao,
  rotuloDe,
} from "@/lib/ia/estados";
import { listarAgentesDoEscritorio, type AgenteComSnapshotUI } from "@/lib/ia/agentes-http";
import type { AgenteUI } from "@/lib/ia/contratos";
import Estacao, { Personagem } from "@/components/ia/office/Estacao";
import PainelAgente from "@/components/ia/office/PainelAgente";
import BadgeEstado from "@/components/ia/BadgeEstado";

/** De quanto em quanto tempo o palco volta a perguntar. */
const INTERVALO_REFRESH_MS = 5_000;

/**
 * O instante em que o proximo flash de `concluido` deixa de valer.
 *
 * ── Por que este calculo existe ─────────────────────────────────────
 *
 * `concluido` e transitorio: `aparenciaDoAgente` compara `concluido_em`
 * com o relogio a CADA render. Se nada provocar um render novo, o flash
 * fica congelado na tela ate o proximo retrato chegar — e o retrato
 * chega de 5 em 5 segundos. Uma tarefa encerrada logo apos uma leitura
 * apagaria com ate 5 s de atraso sobre a janela real.
 *
 * A resposta NAO e perguntar mais vezes. Nada mudou no servidor: quem
 * mudou foi o relogio, e relogio nao se busca pela rede. Entao o palco
 * agenda um despertador LOCAL para o instante exato da fronteira.
 *
 * Devolve `null` quando nao ha nada a expirar — e e por isso que o
 * despertador nao vira um `setInterval` disfarcado: sem flash vivo, nao
 * ha timer nenhum.
 */
function proximaExpiracaoMs(
  agentes: readonly AgenteComSnapshotUI[],
  agoraMs: number
): number | null {
  let proxima: number | null = null;
  for (const item of agentes) {
    for (const sinal of item.sinais) {
      if (sinal.status !== "concluido" || sinal.concluido_em === null) continue;
      const fim = Date.parse(sinal.concluido_em);
      if (Number.isNaN(fim)) continue;
      // A MESMA fronteira de `concluiuRecentemente`: a janela e aberta
      // no fim (`decorrido < JANELA`), entao em `fim + JANELA` o flash
      // ja nao vale. A constante vem de `estados.ts`, dona unica.
      const expira = fim + JANELA_CONCLUIDO_MS;
      if (expira <= agoraMs) continue; // ja expirou: nada a agendar
      if (proxima === null || expira < proxima) proxima = expira;
    }
  }
  return proxima;
}

type EstadoDaLeitura = "carregando" | "ok" | "nao_autenticado" | "falha";

export default function Escritorio() {
  // `agoraMs` avanca a cada leitura: e o que faz o flash de conclusao
  // expirar. Ele nasce `null` para que o primeiro render seja igual nos
  // dois lados da hidratacao — o relogio so e lido depois da montagem.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [estado, setEstado] = useState<EstadoDaLeitura>("carregando");
  // O ULTIMO retrato bom. Uma falha de refresh nao o apaga: a tela
  // continua mostrando o que sabe, em vez de piscar para vazio por causa
  // de um Wi-Fi que caiu por dois segundos.
  const [agentes, setAgentes] = useState<readonly AgenteComSnapshotUI[]>([]);

  useEffect(() => {
    // UMA unica linha de execucao. `vivo` fecha a porta do estado: uma
    // resposta que chega depois da desmontagem nao tem mais onde
    // escrever, e nao ha `setState` em componente morto.
    let vivo = true;
    let agendamento: number | null = null;
    const controlador = new AbortController();

    const ciclo = async () => {
      const resposta = await listarAgentesDoEscritorio(controlador.signal);
      if (!vivo) return;

      if (resposta.estado === "ok") {
        setAgentes(resposta.agentes);
        setAgoraMs(Date.now());
        setEstado("ok");
      } else if (resposta.estado === "nao_autenticado") {
        setEstado("nao_autenticado");
      } else {
        // Falha de refresh PRESERVA o retrato anterior; falha na
        // primeira leitura nao tem retrato para preservar e assume o
        // erro. Em nenhum dos dois casos a tela cai para dado simulado.
        setEstado((anterior) => (anterior === "ok" ? "ok" : "falha"));
      }

      // Agendado SO agora, depois da resposta: nunca ha dois ciclos em
      // voo, e uma falha nao acelera a proxima tentativa.
      if (vivo) agendamento = window.setTimeout(() => void ciclo(), INTERVALO_REFRESH_MS);
    };

    void ciclo();

    return () => {
      vivo = false;
      if (agendamento !== null) window.clearTimeout(agendamento);
      controlador.abort();
    };
  }, []);

  // ── O DESPERTADOR VISUAL ──────────────────────────────────────────
  //
  // Um so, one-shot, sem rede. Ele nao busca nada: apenas empurra o
  // relogio local para a fronteira, o que faz `aparenciaDoAgente`
  // recalcular e o flash apagar no instante certo.
  //
  // Reagendado sempre que o retrato ou o relogio mudam, e o `cleanup`
  // cancela o anterior — entao nunca ha dois despertadores vivos, e um
  // snapshot novo invalida o antigo. Quando ele dispara, `agoraMs`
  // passa da fronteira que o motivou, aquele sinal deixa de contar e o
  // proximo (se houver) e agendado. Sem flash vivo, `proximaExpiracaoMs`
  // devolve `null` e nenhum timer nasce — e o ciclo termina sozinho.
  useEffect(() => {
    if (agoraMs === null) return;
    const expira = proximaExpiracaoMs(agentes, agoraMs);
    if (expira === null) return;
    const despertador = window.setTimeout(() => setAgoraMs(Date.now()), expira - agoraMs);
    return () => window.clearTimeout(despertador);
  }, [agentes, agoraMs]);

  const comAparencia = useMemo(() => {
    if (agoraMs === null) return [];
    return agentes.map((item) => ({
      agente: item.agente,
      // Os cinco estados e o flash transitorio continuam sendo derivados
      // AQUI, pelo helper de sempre. O servidor nao manda estado pronto:
      // manda os sinais de que ele e feito.
      aparencia: aparenciaDoAgente(item.agente, item.sinais, agoraMs),
      atividade: item.atividade,
    }));
  }, [agentes, agoraMs]);

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
          {estado === "carregando" ? (
            <p style={estilos.carregando}>Montando o escritório…</p>
          ) : estado === "nao_autenticado" ? (
            <p style={estilos.carregando} role="alert">
              Sua sessão expirou. Entre novamente para ver o escritório.
            </p>
          ) : estado === "falha" ? (
            // Falha na PRIMEIRA leitura. A tela assume que não conseguiu
            // perguntar — nunca finge um escritório vazio, e nunca cai
            // para dados simulados.
            <p style={estilos.carregando} role="alert">
              Não foi possível carregar o escritório agora. A tela tenta de novo sozinha.
            </p>
          ) : comAparencia.length === 0 ? (
            <p style={estilos.carregando}>
              Você ainda não tem agentes. Crie o primeiro na{" "}
              <a href="/ia/agentes" style={{ color: CROMO.acento }}>lista de agentes</a>.
            </p>
          ) : (
            <div className="cds-ia-zonas">
              <section aria-label="Estações de trabalho" style={{ minWidth: 0 }}>
                <h2 style={estilos.tituloZona}>ESTAÇÕES</h2>
                {naEstacao.length === 0 ? (
                  <p style={estilos.zonaVazia}>Nenhum agente trabalhando agora.</p>
                ) : (
                  <div className="cds-ia-grade">
                    {naEstacao.map(({ agente, aparencia, atividade }) => (
                      <Estacao
                        key={agente.id}
                        agente={agente}
                        aparencia={aparencia}
                        atividade={atividade}
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
          atividade={aberto.atividade}
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
