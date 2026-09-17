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
 * esquecida bateria na rota para sempre. O A3 ligou a decisao e NAO
 * acrescentou intervalo nenhum: quem observa a tarefa retomar e a tela da
 * propria tarefa, nao esta.
 *
 * ── Ordem ───────────────────────────────────────────────────────────
 *
 * A rota ja entrega mais recentes primeiro, com desempate estavel. Esta
 * tela NAO reordena: duas ordens sobre a mesma lista seriam duas
 * verdades sobre o que e "o topo da fila".
 *
 * ── A MUTACAO MORA AQUI, e por card ─────────────────────────────────
 *
 * O card e apresentacional: ele recebe `enviando` e dois callbacks. Quem
 * guarda quais aprovacoes estao em voo, quem chama a rota e quem recarrega
 * a fila e esta tela. O estado e um CONJUNTO de ids, nunca um booleano
 * global — um `enviando` unico deixaria o dono esperando a decisao de uma
 * aprovacao para poder decidir outra, e as duas nao tem relacao.
 *
 * ── Nada de sucesso otimista ────────────────────────────────────────
 *
 * O card so sai da lista quando o GET seguinte deixa de traze-lo. Remover
 * localmente antes do `200` mostraria "decidido" para algo que pode ter
 * falhado no banco, e numa fila de autorizacao essa mentira dura ate a
 * proxima recarga.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  listarAprovacoesPendentes,
  registrarDecisaoAprovacao,
  type DecisaoDeAprovacao,
} from "@/lib/ia/agentes-http";
import type { AprovacaoRealUI } from "@/lib/ia/aprovacoes";
import CardAprovacao from "@/components/ia/aprovacoes/CardAprovacao";
import EstadoVazio from "@/components/ia/EstadoVazio";

type Estado =
  | { fase: "carregando" }
  | { fase: "ok"; aprovacoes: readonly AprovacaoRealUI[] }
  | { fase: "erro"; mensagem: string };

const MSG_FALHA = "Não foi possível carregar a fila de aprovações.";
const MSG_SESSAO = "Sua sessão expirou. Entre novamente para ver a fila.";

/** O sucesso NAO promete conclusao. A aprovacao foi gravada; a retomada
 *  acontece depois, por conta do worker, e pode falhar por motivos que
 *  esta tela nao conhece. Dizer "concluido" aqui seria inventar. */
const MSG_APROVADA = "Aprovação registrada. A tarefa será retomada automaticamente.";
const MSG_REJEITADA = "Rejeição registrada.";
const MSG_INDISPONIVEL =
  "A aprovação não está mais disponível para essa decisão. A fila foi atualizada.";
const MSG_SUMIU = "Essa aprovação não está mais na fila. A fila foi atualizada.";
const MSG_DECISAO_FALHOU = "Não foi possível registrar a decisão. Tente novamente.";

export default function FilaAprovacoes() {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });
  // "solicitada ha X" depende do relogio. Ler no servidor e de novo no
  // cliente produziria HTML divergente — mesmo motivo do Escritorio.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);

  /**
   * A operacao de carga em curso, se houver.
   *
   * ── Por que uma PROMISE e nao um booleano ───────────────────────────
   *
   * A versao anterior guardava `emCursoRef = true` e fazia o chamador
   * concorrente sair seco (`if (emCursoRef.current) return;`). Como trava
   * sincrona de duplo clique aquilo bastava; como reconciliacao pos-decisao
   * era um defeito. Duas decisoes concorrentes — que o desenho permite —
   * produziam esta sequencia: a decisao A termina e inicia um GET; a
   * decisao B termina durante esse GET e o seu `await carregar()` retorna
   * imediatamente, sem recarregar; o GET de A foi emitido ANTES de B
   * persistir e devolve a fila antiga, com B ainda nela. A decisao estava
   * gravada no banco e a tela dizia o contrario.
   *
   * Guardando a PROMISE, o chamador concorrente espera a MESMA operacao, e
   * ela so termina depois de uma leitura iniciada apos o pedido dele.
   */
  const carregamentoAtualRef = useRef<Promise<void> | null>(null);
  /** Alguem pediu recarga enquanto a atual ainda rodava. */
  const recarregarPendenteRef = useRef(false);
  /** Contador de geracao: resposta antiga que chega depois de uma nova
   *  nao pode sobrescrever a nova, e nada e escrito apos desmontar. */
  const geracao = useRef(0);
  const vivo = useRef(true);

  /** As aprovacoes com decisao em voo. O ref e a trava real; o state
   *  existe para o render saber quais cards mostrar como `enviando`. */
  const emVooRef = useRef<Set<string>>(new Set());
  const [enviando, setEnviando] = useState<ReadonlySet<string>>(new Set());
  /** Uma frase de cada vez, anunciada por `aria-live`. */
  const [aviso, setAviso] = useState<string | null>(null);

  /** UMA leitura. Nao sabe nada de concorrencia — quem coordena e
   *  `carregar`. A logica de fase, erro e geracao e a mesma de sempre. */
  const carregarUmaVez = useCallback(async () => {
    const minha = ++geracao.current;
    setEstado({ fase: "carregando" });

    const resposta = await listarAprovacoesPendentes();

    if (!vivo.current || minha !== geracao.current) return;

    if (resposta.estado === "ok") {
      setEstado({ fase: "ok", aprovacoes: resposta.aprovacoes });
    } else if (resposta.estado === "nao_autenticado") {
      setEstado({ fase: "erro", mensagem: MSG_SESSAO });
    } else {
      setEstado({ fase: "erro", mensagem: MSG_FALHA });
    }

    setAgoraMs(Date.now());
  }, []);

  /**
   * A carga COALESCIDA, e o contrato que ela garante.
   *
   * Quem chega durante uma carga em curso nao dispara um segundo GET em
   * paralelo — marca que ha recarga pendente e passa a esperar a MESMA
   * operacao. O lider, ao terminar uma leitura, olha a marca: se alguem
   * pediu enquanto ele lia, le de novo. So resolve quando uma leitura
   * inteira passou sem ninguem pedir outra.
   *
   * O invariante que isso compra: se uma decisao terminou e chamou
   * `carregar()`, o `await` dela nao resolve antes de existir uma leitura
   * INICIADA depois do pedido — e uma terceira decisao que chegue durante
   * essa leitura tambem nao se perde, porque a marca e consultada a cada
   * volta e nao uma vez so.
   *
   * A marca e limpa ANTES de cada leitura, nunca depois: limpa-la ao fim
   * apagaria justamente o pedido que chegou durante a leitura, que e o
   * unico caso que importa.
   *
   * Nao ha timer, intervalo nem retry aqui. A volta extra so acontece
   * quando houve um pedido real.
   */
  const carregar = useCallback((): Promise<void> => {
    if (carregamentoAtualRef.current !== null) {
      recarregarPendenteRef.current = true;
      return carregamentoAtualRef.current;
    }

    const lider = (async () => {
      try {
        do {
          recarregarPendenteRef.current = false;
          await carregarUmaVez();
        } while (recarregarPendenteRef.current && vivo.current);
      } finally {
        // Sempre — inclusive se a leitura lancar. Um ref preso aqui faria
        // todo `carregar()` futuro devolver uma promise ja resolvida e a
        // fila nunca mais recarregaria.
        carregamentoAtualRef.current = null;
        recarregarPendenteRef.current = false;
      }
    })();

    carregamentoAtualRef.current = lider;
    return lider;
  }, [carregarUmaVez]);

  useEffect(() => {
    vivo.current = true;
    setAgoraMs(Date.now());
    void carregar();
    return () => {
      vivo.current = false;
    };
  }, [carregar]);

  /**
   * A DECISAO.
   *
   * `emVooRef` e a trava SINCRONA por aprovacao: `enviando` so vira
   * verdade num render, e dois cliques no mesmo frame atravessariam essa
   * janela juntos. O `Set` do state existe apenas para renderizar; quem
   * decide se a rede acontece e o ref, e ele e consultado ANTES do
   * primeiro `await`.
   *
   * Isto e por APROVACAO, e nao por fila: decidir uma nao bloqueia as
   * outras. A coordenacao da RECARGA e outra camada, em `carregar`, e e
   * ela que garante que o `await` abaixo so termina depois de uma leitura
   * posterior a esta decisao.
   */
  const decidir = useCallback(
    async (aprovacao: AprovacaoRealUI, decisao: DecisaoDeAprovacao) => {
      const id = aprovacao.id;
      if (emVooRef.current.has(id)) return;

      emVooRef.current.add(id);
      setEnviando(new Set(emVooRef.current));
      setAviso(null);

      try {
        const r = await registrarDecisaoAprovacao(id, decisao);
        if (!vivo.current) return;

        if (r.estado === "ok") {
          setAviso(r.decisao === "aprovar" ? MSG_APROVADA : MSG_REJEITADA);
          await carregar();
          return;
        }

        // Corrida perdida: alguem — ou o proprio relogio — mudou a
        // aprovacao entre o GET e o clique. Nao ha decisao nova a afirmar;
        // ha uma fila desatualizada a recarregar.
        if (r.estado === "indisponivel") {
          setAviso(MSG_INDISPONIVEL);
          await carregar();
          return;
        }
        if (r.estado === "nao_encontrada") {
          setAviso(MSG_SUMIU);
          await carregar();
          return;
        }
        if (r.estado === "nao_autenticado") {
          setAviso(MSG_SESSAO);
          return;
        }

        // `entrada_invalida` e `falha` mantem o card: nada foi gravado, e
        // remove-lo ou marca-lo esconderia trabalho que ainda espera.
        setAviso(MSG_DECISAO_FALHOU);
      } finally {
        // SEMPRE. Um id esquecido aqui deixaria o card morto ate a pagina
        // recarregar, e o dono nao teria como saber por que.
        emVooRef.current.delete(id);
        if (vivo.current) setEnviando(new Set(emVooRef.current));
      }
    },
    [carregar]
  );

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

      {/* O aviso vive na FILA, nao no card: o card decidido desaparece no
          refetch, e um feedback preso a ele sumiria junto com a unica
          confirmacao de que a decisao foi gravada. */}
      <p className="cds-ia-fila-aviso" aria-live="polite">
        {aviso ?? ""}
      </p>

      <ul className="cds-ia-fila-lista">
        {fila.map((a) => (
          <li key={a.id}>
            <CardAprovacao
              aprovacao={a}
              agoraMs={agoraMs ?? 0}
              enviando={enviando.has(a.id)}
              onAprovar={(x) => void decidir(x, "aprovar")}
              onRecusar={(x) => void decidir(x, "rejeitar")}
            />
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
  /* Reserva a altura mesmo vazio: o aviso aparecendo e sumindo nao pode
     empurrar a lista e mover o botao que o dono acabou de mirar. */
  .cds-ia-fila-aviso {
    min-height: 1.6em; margin: 0 0 ${ESPACO.md}px;
    font: 12px/1.6 ${FONTE.interface}; color: ${CROMO.texto};
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
