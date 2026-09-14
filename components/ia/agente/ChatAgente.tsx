"use client";

/**
 * A aba Chat do agente — AGENT-VERTICAL-SLICE-V1-I3.
 *
 * ── O elo que faltava ───────────────────────────────────────────────
 *
 * Escrever aqui cria uma TAREFA de verdade, do tipo `conversa`, ligada a
 * este agente. Quem a executa e o runtime publicado: ele carrega o
 * agente persistido, usa as instrucoes que o dono salvou e chama a IA.
 * Esta tela nao decide nada disso — ela pergunta e acompanha.
 *
 * ── Uma mensagem, uma tarefa, uma resposta ──────────────────────────
 *
 * Nao ha memoria conversacional: cada envio e independente, e a tela diz
 * isso em vez de sugerir um historico que nao existe. Nada e persistido
 * do lado do navegador — recarregar perde a troca, e isso e honesto para
 * uma V1 que ainda nao tem onde guardar conversa.
 *
 * ── Por que o polling e encadeado ───────────────────────────────────
 *
 * `setTimeout` DEPOIS da resposta anterior, nunca `setInterval`. Com
 * intervalo cego, uma consulta lenta acumula outra por cima, e duas
 * respostas fora de ordem podem regredir a tela. Encadeado, existe no
 * maximo uma consulta em voo.
 *
 * ── Por que existe uma geracao ──────────────────────────────────────
 *
 * Trocar de agente ou enviar outra mensagem invalida tudo que estava em
 * voo. Sem isso, a resposta atrasada de uma tarefa anterior sobrescreve
 * o estado da atual — o bug classico de acompanhamento assincrono. O
 * contador de geracao e o `AbortController` cuidam disso; a desmontagem
 * cancela os dois.
 *
 * ── O modo de IA nao afirma proveniencia ────────────────────────────
 *
 * `modoNoEnvio` e `modoAtual` sao guardados SEPARADOS, porque a API
 * reporta a configuracao do instante da requisicao e nada mais. Se a
 * flag mudar no meio do caminho, a tela avisa em vez de escolher uma das
 * duas leituras e apresenta-la como fato.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  MARCADOR_FAKE,
  condicoesIaRealAtendidas,
  consultarConversaDoAgente,
  ehStatusTerminal,
  enviarMensagemAoAgente,
  type ModoIa,
  type StatusConversa,
  type TarefaConversaUI,
} from "@/lib/ia/agentes-http";

/** Entre uma consulta e a proxima. Curto o bastante para a tela nao
 *  parecer parada, longo o bastante para nao martelar a API. */
const INTERVALO_CONSULTA_MS = 1500;

/** O que a tela mostra para cada estado. `pendente` e `rodando` sao os
 *  unicos que continuam sendo consultados. */
const ROTULO: Record<StatusConversa, string> = {
  pendente: "Na fila",
  rodando: "Processando",
  aguardando_aprovacao: "Aguardando aprovação",
  concluido: "Pronto",
  erro: "Falhou",
  cancelado: "Cancelada",
};

type Falha =
  | { onde: "envio"; texto: string }
  | { onde: "consulta"; texto: string };

const TEXTO_ENVIO: Record<string, string> = {
  nao_autenticado: "Sua sessão expirou. Entre novamente para conversar.",
  nao_encontrado: "Este agente não está mais disponível.",
  agente_inativo: "Este agente está desligado. Ative-o para conversar.",
  entrada_invalida: "Não foi possível enviar essa mensagem.",
  falha: "Não foi possível enviar a mensagem.",
};

export default function ChatAgente({ agenteId }: { agenteId: string }) {
  const [rascunho, setRascunho] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [conversa, setConversa] = useState<TarefaConversaUI | null>(null);
  const [enviada, setEnviada] = useState<string | null>(null);
  const [modoNoEnvio, setModoNoEnvio] = useState<ModoIa | null>(null);
  const [modoAtual, setModoAtual] = useState<ModoIa | null>(null);
  const [falha, setFalha] = useState<Falha | null>(null);

  // A geracao invalida trabalho antigo; o controlador aborta o que ainda
  // estiver em voo; o timer e cancelado na saida. Os tres juntos sao o
  // que impede uma resposta velha de pisar numa tarefa nova.
  const geracao = useRef(0);
  const controlador = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);

  const encerrarAcompanhamento = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    controlador.current?.abort();
    controlador.current = null;
  }, []);

  // Trocar de agente descarta tudo: a tarefa anterior era de outro
  // recurso e nao tem nada que dizer sobre este.
  useEffect(() => {
    geracao.current += 1;
    encerrarAcompanhamento();
    setConversa(null);
    setEnviada(null);
    setModoNoEnvio(null);
    setModoAtual(null);
    setFalha(null);
    setEnviando(false);
    return () => {
      geracao.current += 1;
      encerrarAcompanhamento();
    };
  }, [agenteId, encerrarAcompanhamento]);

  /** Uma consulta. Reagenda a proxima SOMENTE se ainda houver o que
   *  esperar e a geracao continuar valendo. */
  const acompanhar = useCallback(
    async (tarefaId: string, minhaGeracao: number) => {
      controlador.current = new AbortController();
      const r = await consultarConversaDoAgente(agenteId, tarefaId, controlador.current.signal);
      if (minhaGeracao !== geracao.current) return;

      if (r.estado !== "ok") {
        // O `tarefaId` sobrevive: a consulta falhou, a tarefa nao. Por
        // isso ha um botao para tentar de novo em vez de um novo envio.
        setFalha({
          onde: "consulta",
          texto:
            r.estado === "nao_autenticado"
              ? "Sua sessão expirou. Entre novamente para ver o resultado."
              : "Não foi possível consultar o status.",
        });
        return;
      }

      setConversa(r.tarefa);
      setModoAtual(r.modo);
      setFalha(null);

      if (ehStatusTerminal(r.tarefa.status)) return;
      timer.current = window.setTimeout(() => {
        if (minhaGeracao !== geracao.current) return;
        void acompanhar(tarefaId, minhaGeracao);
      }, INTERVALO_CONSULTA_MS);
    },
    [agenteId]
  );

  const enviar = useCallback(async () => {
    const mensagem = rascunho.trim();
    if (mensagem.length === 0 || enviando) return;

    geracao.current += 1;
    const minhaGeracao = geracao.current;
    encerrarAcompanhamento();

    setEnviando(true);
    setFalha(null);
    setConversa(null);
    setModoAtual(null);

    const r = await enviarMensagemAoAgente(agenteId, mensagem);
    if (minhaGeracao !== geracao.current) return;
    setEnviando(false);

    if (r.estado !== "ok") {
      // Sem tarefa, sem acompanhamento e sem id inventado. O campo
      // continua liberado para tentar de novo.
      setFalha({ onde: "envio", texto: TEXTO_ENVIO[r.estado] ?? TEXTO_ENVIO.falha });
      return;
    }

    setEnviada(mensagem);
    setRascunho("");
    setModoNoEnvio(r.modo);
    setModoAtual(r.modo);
    setConversa({ id: r.tarefaId, status: r.status, resposta: null, erroTipo: null });

    if (!ehStatusTerminal(r.status)) void acompanhar(r.tarefaId, minhaGeracao);
  }, [acompanhar, agenteId, encerrarAcompanhamento, enviando, rascunho]);

  /**
   * Tentar consultar de novo a MESMA tarefa. Nunca cria outra.
   *
   * ── Por que a geracao tambem sobe aqui ────────────────────────────
   *
   * Este era o unico dos quatro pontos que chamava
   * `encerrarAcompanhamento()` SEM invalidar a geracao — e o abort que
   * ele dispara volta de `consultarConversaDoAgente` como
   * `{estado:"falha"}`, indistinguivel de uma falha real. Com a geracao
   * intacta, a cadeia abortada passava pelo proprio check e escrevia
   * estado: dois cliques seguidos no botao produziam um erro FALSO, e,
   * se a resposta ja tivesse chegado antes do abort, a cadeia morta
   * ainda agendava um `setTimeout` que sobrescrevia o da cadeia viva —
   * deixando dois acompanhamentos simultaneos da mesma tarefa.
   *
   * Subir a geracao antes de encerrar alinha este ponto com os outros
   * tres (`enviar`, o efeito de `agenteId` e o cleanup): o que estava em
   * voo vira stale e e descartado no lugar de sobrescrever.
   */
  const reconsultar = useCallback(() => {
    if (conversa === null) return;
    geracao.current += 1;
    const minhaGeracao = geracao.current;
    encerrarAcompanhamento();
    setFalha(null);
    void acompanhar(conversa.id, minhaGeracao);
  }, [acompanhar, conversa, encerrarAcompanhamento]);

  const emAndamento = conversa !== null && !ehStatusTerminal(conversa.status);
  const bloqueado = enviando || emAndamento;
  const respostaFake = conversa?.resposta?.includes(MARCADOR_FAKE) ?? false;
  const pilotoReal =
    conversa !== null &&
    condicoesIaRealAtendidas({
      status: conversa.status,
      modoNoEnvio,
      modoAtual,
      resposta: conversa.resposta,
    });

  return (
    <>
      <style>{css}</style>
      <section className="cds-chat" aria-label="Conversa com o agente">
        <p className="cds-chat-nota">
          Cada mensagem é processada de forma independente nesta versão: o agente não guarda o
          que foi dito antes.
        </p>

        <div className="cds-chat-troca" aria-live="polite">
          {enviada !== null && (
            <p className="cds-chat-voce">
              <span className="cds-chat-quem">Você</span>
              <span className="cds-chat-texto">{enviada}</span>
            </p>
          )}

          {conversa !== null && (
            <div className="cds-chat-agente">
              <span className="cds-chat-quem">
                Agente · {ROTULO[conversa.status] ?? "Status não reconhecido"}
              </span>

              {conversa.status === "pendente" && (
                <span className="cds-chat-espera">
                  Na fila. Neste piloto, o processador de tarefas precisa estar em execução para
                  que ela avance.
                </span>
              )}
              {conversa.status === "rodando" && (
                <span className="cds-chat-espera">Processando…</span>
              )}
              {conversa.status === "concluido" && conversa.resposta !== null && (
                <span className="cds-chat-texto">{conversa.resposta}</span>
              )}
              {conversa.status === "erro" && (
                <span className="cds-chat-espera">
                  A tarefa falhou.
                  {conversa.erroTipo !== null ? ` Código: ${conversa.erroTipo}` : ""}
                </span>
              )}
              {conversa.status === "cancelado" && (
                <span className="cds-chat-espera">Tarefa cancelada.</span>
              )}
              {conversa.status === "aguardando_aprovacao" && (
                <span className="cds-chat-espera">A tarefa está aguardando aprovação.</span>
              )}
            </div>
          )}

          {falha !== null && (
            <p className="cds-chat-falha" role="alert">
              {falha.texto}
              {falha.onde === "consulta" && conversa !== null && (
                <button type="button" className="cds-chat-reconsultar" onClick={reconsultar}>
                  Atualizar status
                </button>
              )}
            </p>
          )}
        </div>

        <div className="cds-chat-modo">
          {modoAtual === "fake" && <span className="cds-chat-tag">Modo de teste (fake)</span>}
          {modoAtual === "real" && (
            <span className="cds-chat-tag">Configuração atual: IA real</span>
          )}
          {respostaFake && <span className="cds-chat-tag">Resposta de teste.</span>}
          {modoNoEnvio !== null && modoAtual !== null && modoNoEnvio !== modoAtual && (
            <span className="cds-chat-tag cds-chat-tag-aviso">
              A configuração de IA mudou desde o envio.
            </span>
          )}
          {pilotoReal && (
            <span className="cds-chat-tag">Condições do teste com IA real atendidas.</span>
          )}
        </div>

        <label className="cds-chat-rotulo" htmlFor="cds-chat-mensagem">
          Mensagem para o agente
        </label>
        <textarea
          id="cds-chat-mensagem"
          className="cds-chat-entrada"
          rows={3}
          value={rascunho}
          disabled={bloqueado}
          onChange={(e) => setRascunho(e.target.value)}
          placeholder="Escreva o que você quer pedir a este agente…"
        />
        <button
          type="button"
          className="cds-chat-enviar"
          onClick={() => void enviar()}
          disabled={bloqueado || rascunho.trim().length === 0}
        >
          {enviando ? "Enviando…" : "Enviar"}
        </button>
      </section>
    </>
  );
}

const css = `
  .cds-chat { display: grid; gap: ${ESPACO.md}px; max-width: 720px; }
  .cds-chat-nota { margin: 0; font: 12px/1.5 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-chat-troca { display: grid; gap: ${ESPACO.sm}px; min-height: 40px; }
  .cds-chat-voce, .cds-chat-agente {
    display: grid; gap: 4px; margin: 0;
    padding: ${ESPACO.md}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-chat-quem { font: 700 11px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-chat-texto {
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.texto};
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .cds-chat-espera { font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-chat-falha {
    margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: ${ESPACO.sm}px;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.texto};
  }
  .cds-chat-reconsultar {
    font: 12px/1.4 ${FONTE.interface};
    padding: 4px 10px; cursor: pointer;
    color: ${CROMO.texto};
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-chat-modo { display: flex; flex-wrap: wrap; gap: ${ESPACO.sm}px; }
  .cds-chat-tag {
    font: 11px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco};
    padding: 3px 8px;
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-chat-tag-aviso { color: ${CROMO.texto}; }
  .cds-chat-rotulo { font: 700 12px/1.4 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-chat-entrada {
    width: 100%; box-sizing: border-box;
    padding: ${ESPACO.md}px;
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
    resize: vertical;
  }
  .cds-chat-entrada:focus-visible, .cds-chat-enviar:focus-visible,
  .cds-chat-reconsultar:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 2px; }
  .cds-chat-enviar {
    justify-self: start;
    font: 700 13px/1.4 ${FONTE.interface};
    padding: 8px 16px; cursor: pointer;
    color: ${CROMO.texto};
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-chat-enviar:disabled, .cds-chat-entrada:disabled { opacity: 0.55; cursor: not-allowed; }
`;
