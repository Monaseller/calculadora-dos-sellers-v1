"use client";

/**
 * Disparo e acompanhamento de `vendas.consultar` — FUNCTION-RUNTIME-V1-B2B.
 *
 * ── O que esta tela e ───────────────────────────────────────────────
 *
 * A primeira superficie em que o dono manda uma Funcao REAL trabalhar.
 * Ela nao executa nada: monta um filtro, pede ao servidor que enfileire
 * uma tarefa `consultar_vendas` e depois pergunta, de tempos em tempos,
 * em que pe ela esta. Quem executa e o dispatcher publicado na V1-B1,
 * acionado pelo Vercel Cron.
 *
 * ── Zero rede aqui dentro ───────────────────────────────────────────
 *
 * Nenhuma chamada de rede e nenhum endereco de API sao escritos aqui.
 * Todo transporte vive em `lib/ia/agentes-http.ts`, e isso nao e estilo:
 * a suite `testar-ia-agentes-ui-source.ts` exige que EXATAMENTE UM
 * arquivo da area de IA tenha rede e construa endereco. Uma chamada
 * direta aqui derrubaria A1 e A2 — e a resposta certa seria mover a
 * chamada para o transporte, nunca afrouxar os asserts.
 *
 * ── A permissao aqui e UX, nunca autoridade ─────────────────────────
 *
 * O nivel de autonomia decide o que a tela OFERECE. Quem decide o que
 * acontece e `executarFuncao`, no runtime — ele produz negado, pausa por
 * aprovacao ou sucesso, e continua fazendo isso mesmo que alguem chegue
 * na API por outro caminho. Duplicar a regra aqui criaria uma segunda
 * autoridade, e duas autoridades divergem.
 *
 * ── Por que nao ha botao Cancelar ───────────────────────────────────
 *
 * Porque o produto nao tem cancelamento. `cancelado` existe no
 * vocabulario de status e e exibido se aparecer, mas nenhuma rota o
 * produz. Um botao que nao cancela e pior que a ausencia dele.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import type { NivelAutonomia } from "@/lib/ia/conceitos";
import {
  consultarConsultaVendasDoAgente,
  criarConsultaVendasDoAgente,
  type MarketplaceConsultaVendas,
  type ResultadoConsultaVendasUI,
  type StatusConversa,
  type TarefaConsultaVendasUI,
} from "@/lib/ia/agentes-http";

/**
 * A Funcao que ESTE componente implementa.
 *
 * O id mora aqui, e nao na lista de Funcoes, por uma razao que a suite
 * guarda em J6: o catalogo e do SERVIDOR. `FuncoesAgente` renderiza o
 * que a API devolve e nao pode carregar nomes de Funcao — carregar
 * abriria um segundo catalogo, no cliente, livre para divergir do
 * registry. Quem sabe a qual Funcao esta tela serve e a propria tela.
 */
export const FUNCAO_EXECUTAVEL = "vendas.consultar";

/** A lista pergunta; ela nao precisa saber a resposta por dentro. */
export function temSuperficieDeExecucao(funcaoId: string): boolean {
  return funcaoId === FUNCAO_EXECUTAVEL;
}

/** Mesmo ritmo do Chat: rapido o suficiente para parecer vivo, longe de
 *  ser agressivo com uma tarefa que leva no minimo uma janela de cron. */
const INTERVALO_CONSULTA_MS = 1500;

/**
 * Falhas de rede consecutivas toleradas antes de desistir do
 * acompanhamento.
 *
 * Uma unica falha de rede nao diz nada sobre a tarefa: ela continua
 * viva no servidor. Desistir na primeira transformaria um soluco de
 * conexao em "deu erro", o que seria mentira. Tres seguidas ja indicam
 * que perguntar de novo nao vai ajudar — e mesmo entao a tarefa NAO e
 * alterada, so o acompanhamento para.
 */
const FALHAS_TOLERADAS = 3;

/** O nome e especifico de proposito: um `?tarefa=` generico colidiria
 *  com qualquer outra superficie que venha a guardar id na URL. */
const PARAM_TAREFA = "tarefaVendas";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Quando PARAR de perguntar pela tarefa — regra DESTA tela.
 *
 * `ehStatusTerminal`, do transporte, responde outra pergunta: "a conversa
 * parou de andar sozinha?". Para o chat, `aguardando_aprovacao` e um fim
 * de linha honesto. Aqui nao e, e a diferenca custou o primeiro E2E real:
 * a tela via `aguardando_aprovacao`, encerrava o acompanhamento e nunca
 * descobria que a tarefa tinha sido aprovada, retomada e concluida.
 *
 * O comentario que justificava reaproveitar o helper dizia que a decisao
 * "ainda nao existe na interface". Existe desde a APPROVAL-UI-API-A3: o
 * humano decide na fila e o worker retoma. Entao a espera por aprovacao
 * voltou a ser um estado TRANSITORIO — alguem vai decidir, e a tarefa vai
 * andar sem que esta tela peca nada.
 *
 * O helper compartilhado continua intocado de proposito: mudar a regra
 * dele moveria o comportamento do chat junto, que nao foi revisado aqui.
 */
const STATUS_QUE_PARAM_O_ACOMPANHAMENTO: readonly StatusConversa[] = [
  "concluido",
  "erro",
  "cancelado",
];

const paraDeAcompanhar = (status: StatusConversa): boolean =>
  STATUS_QUE_PARAM_O_ACOMPANHAMENTO.includes(status);

const ROTULO_STATUS: Record<StatusConversa, string> = {
  pendente: "Na fila",
  rodando: "Consultando vendas",
  aguardando_aprovacao: "Aguardando aprovação",
  concluido: "Concluído",
  erro: "Erro na execução",
  cancelado: "Cancelado",
};

/**
 * Os codigos que o validador de dominio devolve no 400.
 *
 * Mapeados para frase, nao repetidos como regra: a janela de dias, o
 * formato da data e o enum de marketplace continuam sendo decididos no
 * servidor. Um codigo fora desta lista cai na frase generica — refletir
 * a string crua poria vocabulario interno na tela.
 */
const FRASE_ENTRADA_INVALIDA: Record<string, string> = {
  filtro_ausente: "Informe as duas datas.",
  data_invalida: "Use datas válidas, no formato AAAA-MM-DD.",
  periodo_invertido: "A data final não pode ser anterior à inicial.",
  janela_excedida: "O período é longo demais. Escolha uma janela menor.",
  marketplace_invalido: "Marketplace inválido.",
};

const FALHA_GENERICA = "Não foi possível iniciar a consulta. Tente novamente em instantes.";
const FALHA_ACOMPANHAMENTO = "Não foi possível atualizar o status desta consulta.";
const FALHA_RESULTADO = "A consulta terminou, mas o resultado não pôde ser exibido.";

const dinheiro = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const inteiro = new Intl.NumberFormat("pt-BR");

/** Nivel que permite DISPARAR. `null` e `bloqueado` nao oferecem o
 *  botao; `aprovacao` oferece com aviso, porque a pausa e um desfecho
 *  legitimo e nao uma recusa. */
function podeDisparar(nivel: NivelAutonomia | null): boolean {
  return nivel === "aprovacao" || nivel === "automatico";
}

export default function ExecutarConsultaVendas({
  agenteId,
  nivel,
}: {
  agenteId: string;
  nivel: NivelAutonomia | null;
}) {
  const router = useRouter();
  const parametros = useSearchParams();

  const [dataInicio, setDataInicio] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [marketplace, setMarketplace] = useState<MarketplaceConsultaVendas>(null);

  const [enviando, setEnviando] = useState(false);
  const [tarefa, setTarefa] = useState<TarefaConsultaVendasUI | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // A geracao invalida trabalho antigo; o controlador aborta o que ainda
  // esta no ar. Sem os dois, uma resposta lenta de um ciclo anterior
  // sobrescreveria o estado do ciclo atual — o mesmo arranjo do Chat.
  const geracao = useRef(0);
  const controlador = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const falhasSeguidas = useRef(0);

  /**
   * A trava SINCRONA do envio.
   *
   * `bloqueado` deriva de state, e state so vira `true` no proximo
   * render. Dois submits despachados no mesmo frame — duplo clique
   * rapido, Enter repetido — leem os dois `enviando === false` e
   * atravessam juntos, criando DUAS tarefas `consultar_vendas`. Duas
   * execucoes reais de Funcao, e no nivel `aprovacao` potencialmente
   * duas Approvals, que sao append-only e ninguem consegue apagar.
   *
   * Um ref muda no mesmo instante em que e escrito. Ele nao substitui o
   * `disabled` nem o guard de `bloqueado`: fecha so a janela entre o
   * primeiro evento e o render que os dois outros dependem.
   */
  const envioEmCursoRef = useRef(false);

  /**
   * A liberacao acontece DEPOIS do render, nunca num `finally`.
   *
   * Um `finally` no proprio handler devolveria a trava enquanto
   * `enviando` ainda fosse `true` na tela e — no caminho de sucesso —
   * antes de a tarefa ativa existir no estado. Haveria um instante em
   * que nem o ref, nem `enviando`, nem `emAndamento` bloqueariam. Este
   * efeito so roda apos o commit, entao quando ele ve `enviando ===
   * false` a tela ja materializou o fim do envio.
   */
  useEffect(() => {
    if (!enviando) envioEmCursoRef.current = false;
  }, [enviando]);

  const encerrarAcompanhamento = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    controlador.current?.abort();
    controlador.current = null;
  }, []);

  // Desmontou: nada do que estava no ar pode voltar e mexer em estado.
  useEffect(() => {
    return () => {
      geracao.current += 1;
      encerrarAcompanhamento();
    };
  }, [encerrarAcompanhamento]);

  const limparParametro = useCallback(() => {
    const atuais = new URLSearchParams(parametros?.toString() ?? "");
    if (!atuais.has(PARAM_TAREFA)) return;
    atuais.delete(PARAM_TAREFA);
    const busca = atuais.toString();
    router.replace(busca.length > 0 ? `?${busca}` : "?", { scroll: false });
  }, [parametros, router]);

  const gravarParametro = useCallback(
    (tarefaId: string) => {
      const atuais = new URLSearchParams(parametros?.toString() ?? "");
      atuais.set(PARAM_TAREFA, tarefaId);
      router.replace(`?${atuais.toString()}`, { scroll: false });
    },
    [parametros, router]
  );

  /**
   * Um ciclo de acompanhamento. Reagenda a si mesmo com `setTimeout`
   * DEPOIS da resposta anterior — nunca `setInterval`, que enfileiraria
   * chamadas se o servidor demorasse mais que o intervalo.
   */
  const acompanhar = useCallback(
    async (tarefaId: string, minhaGeracao: number): Promise<void> => {
      if (minhaGeracao !== geracao.current) return;

      controlador.current = new AbortController();
      const r = await consultarConsultaVendasDoAgente(
        agenteId,
        tarefaId,
        controlador.current.signal
      );
      if (minhaGeracao !== geracao.current) return;

      if (r.estado !== "ok") {
        // A tarefa NAO e alterada por uma falha de acompanhamento: ela
        // segue viva no servidor. Some quem pergunta, nao quem trabalha.
        if (r.estado === "nao_encontrado") {
          setTarefa(null);
          setAviso(null);
          limparParametro();
          return;
        }
        falhasSeguidas.current += 1;
        if (falhasSeguidas.current >= FALHAS_TOLERADAS) {
          setAviso(FALHA_ACOMPANHAMENTO);
          return;
        }
        timer.current = window.setTimeout(() => {
          if (minhaGeracao !== geracao.current) return;
          void acompanhar(tarefaId, minhaGeracao);
        }, INTERVALO_CONSULTA_MS);
        return;
      }

      falhasSeguidas.current = 0;
      setTarefa(r.tarefa);

      // Terminal significa: nao adianta perguntar de novo. Isso inclui
      // `aguardando_aprovacao` — a tarefa nao anda ate alguem decidir, e
      // essa decisao ainda nao existe na interface.
      if (paraDeAcompanhar(r.tarefa.status)) return;

      timer.current = window.setTimeout(() => {
        if (minhaGeracao !== geracao.current) return;
        void acompanhar(tarefaId, minhaGeracao);
      }, INTERVALO_CONSULTA_MS);
    },
    [agenteId, limparParametro]
  );

  // Recarregou a pagina: o id da tarefa sobrevive na URL, e o estado
  // volta do SERVIDOR. A URL guarda um identificador e nada mais — nunca
  // resultado, que e dado financeiro do dono.
  const idDaUrl = parametros?.get(PARAM_TAREFA) ?? null;
  useEffect(() => {
    if (tarefa !== null || enviando) return;
    if (idDaUrl === null || !UUID_REGEX.test(idDaUrl)) return;

    geracao.current += 1;
    const minhaGeracao = geracao.current;
    falhasSeguidas.current = 0;
    void acompanhar(idDaUrl, minhaGeracao);
  }, [idDaUrl, tarefa, enviando, acompanhar]);

  const emAndamento =
    tarefa !== null && (tarefa.status === "pendente" || tarefa.status === "rodando");
  const aguardandoAprovacao = tarefa !== null && tarefa.status === "aguardando_aprovacao";

  // Enquanto houver execucao viva — ou parada esperando decisao —, um
  // segundo disparo so acumularia trabalho que ninguem consegue
  // acompanhar. Sem lock de banco: e UX, e e o suficiente aqui.
  const bloqueado =
    !podeDisparar(nivel) ||
    enviando ||
    emAndamento ||
    aguardandoAprovacao ||
    dataInicio.length === 0 ||
    dataFim.length === 0;

  async function enviar(evento: React.FormEvent) {
    evento.preventDefault();
    // A trava vem PRIMEIRO e e lida antes de qualquer coisa assincrona:
    // e o unico guard que ja esta fechado para o segundo evento do mesmo
    // frame. Os outros dois — `bloqueado` e o `disabled` — continuam
    // valendo, e cobrem tudo o que acontece depois do render.
    if (envioEmCursoRef.current) return;
    if (bloqueado) return;
    envioEmCursoRef.current = true;

    encerrarAcompanhamento();
    geracao.current += 1;
    const minhaGeracao = geracao.current;

    setEnviando(true);
    setAviso(null);
    setTarefa(null);
    falhasSeguidas.current = 0;

    const r = await criarConsultaVendasDoAgente(agenteId, {
      dataInicio,
      dataFim,
      marketplace,
    });

    if (minhaGeracao !== geracao.current) return;
    setEnviando(false);

    if (r.estado !== "ok") {
      // Nenhum corpo cru chega a tela: ou e uma frase do vocabulario
      // conhecido, ou e a generica.
      if (r.estado === "entrada_invalida") {
        setAviso(
          (r.codigo !== null ? FRASE_ENTRADA_INVALIDA[r.codigo] : undefined) ??
            "Revise o período informado."
        );
      } else if (r.estado === "nao_autenticado") {
        setAviso("Sua sessão expirou. Entre novamente.");
      } else if (r.estado === "agente_inativo") {
        setAviso("Este agente está desativado.");
      } else {
        setAviso(FALHA_GENERICA);
      }
      return;
    }

    setTarefa({
      id: r.tarefaId,
      status: r.status,
      resultado: null,
      erroTipo: null,
      criadoEm: null,
      iniciadoEm: null,
      concluidoEm: null,
    });
    gravarParametro(r.tarefaId);
    void acompanhar(r.tarefaId, minhaGeracao);
  }

  return (
    <div className="cds-cv">
      <style>{css}</style>

      <form className="cds-cv-form" onSubmit={enviar}>
        <div className="cds-cv-campos">
          <div className="cds-cv-campo">
            <label className="cds-cv-rotulo" htmlFor="cds-cv-inicio">
              Data inicial
            </label>
            <input
              id="cds-cv-inicio"
              type="date"
              className="cds-cv-entrada"
              value={dataInicio}
              onChange={(e) => setDataInicio(e.target.value)}
              disabled={!podeDisparar(nivel)}
            />
          </div>

          <div className="cds-cv-campo">
            <label className="cds-cv-rotulo" htmlFor="cds-cv-fim">
              Data final
            </label>
            <input
              id="cds-cv-fim"
              type="date"
              className="cds-cv-entrada"
              value={dataFim}
              onChange={(e) => setDataFim(e.target.value)}
              disabled={!podeDisparar(nivel)}
            />
          </div>

          <div className="cds-cv-campo">
            <label className="cds-cv-rotulo" htmlFor="cds-cv-marketplace">
              Marketplace
            </label>
            <select
              id="cds-cv-marketplace"
              className="cds-cv-entrada"
              value={marketplace ?? ""}
              onChange={(e) =>
                setMarketplace(e.target.value === "" ? null : (e.target.value as "Shopee" | "ML"))
              }
              disabled={!podeDisparar(nivel)}
            >
              <option value="">Todos</option>
              <option value="Shopee">Shopee</option>
              <option value="ML">Mercado Livre</option>
            </select>
          </div>
        </div>

        <button type="submit" className="cds-cv-botao" disabled={bloqueado}>
          {enviando ? "Enviando..." : "Consultar vendas"}
        </button>
      </form>

      {/* Permissao como UX. O runtime continua decidindo de verdade. */}
      {nivel === null && (
        <p className="cds-cv-nota">
          Escolha um nível de acesso acima para o agente poder consultar as vendas.
        </p>
      )}
      {nivel === "bloqueado" && (
        <p className="cds-cv-nota">Esta função está bloqueada para este agente.</p>
      )}
      {nivel === "aprovacao" && (
        <p className="cds-cv-nota">
          Esta execução poderá parar e aguardar a sua aprovação antes de consultar as vendas.
        </p>
      )}

      {aviso !== null && (
        <p className="cds-cv-aviso" role="status">
          {aviso}
        </p>
      )}

      {tarefa !== null && (
        <div className="cds-cv-execucao">
          <p className="cds-cv-status" role="status">
            <strong>{ROTULO_STATUS[tarefa.status]}</strong>
            {tarefa.status === "pendente" && (
              <span className="cds-cv-detalhe">
                {" "}
                — a execução começa na próxima rodada do processador.
              </span>
            )}
          </p>

          {tarefa.status === "aguardando_aprovacao" && (
            <p className="cds-cv-nota">
              Esta execução precisa de aprovação. A tela de aprovações será disponibilizada em uma
              etapa seguinte.
            </p>
          )}

          {tarefa.status === "erro" && (
            <p className="cds-cv-aviso">
              {tarefa.erroTipo !== null
                ? `Não foi possível concluir a consulta (${tarefa.erroTipo}).`
                : "Não foi possível concluir a consulta."}
            </p>
          )}

          {tarefa.status === "concluido" &&
            (tarefa.resultado === null ? (
              <p className="cds-cv-aviso">{FALHA_RESULTADO}</p>
            ) : (
              <Resultado dados={tarefa.resultado} />
            ))}
        </div>
      )}
    </div>
  );
}

/** Apresentacao pura do agregado. Nenhum numero e recalculado aqui: o
 *  faturamento, o ticket e a contagem de pedidos vem prontos do handler,
 *  que e a autoridade sobre eles. */
function Resultado({ dados }: { dados: ResultadoConsultaVendasUI }) {
  const { periodo, resumo, marketplaces, truncado } = dados;

  return (
    <div className="cds-cv-resultado">
      <p className="cds-cv-periodo">
        {periodo.dataInicio} a {periodo.dataFim} ·{" "}
        {periodo.marketplace === null ? "Todos os marketplaces" : periodo.marketplace}
      </p>

      <dl className="cds-cv-numeros">
        <Numero rotulo="Pedidos" valor={inteiro.format(resumo.pedidos)} />
        <Numero rotulo="Unidades" valor={inteiro.format(resumo.unidades)} />
        <Numero rotulo="Faturamento" valor={dinheiro.format(resumo.faturamento)} />
        <Numero rotulo="Ticket médio" valor={dinheiro.format(resumo.ticketMedio)} />
        <Numero rotulo="SKUs distintos" valor={inteiro.format(resumo.skusDistintos)} />
      </dl>

      <table className="cds-cv-tabela">
        <caption className="cds-cv-legenda">Por marketplace</caption>
        <thead>
          <tr>
            <th scope="col">Marketplace</th>
            <th scope="col">Pedidos</th>
            <th scope="col">Unidades</th>
            <th scope="col">Faturamento</th>
          </tr>
        </thead>
        <tbody>
          {(["Shopee", "ML", "outros"] as const).map((nome) => (
            <tr key={nome}>
              <th scope="row">{nome === "ML" ? "Mercado Livre" : nome}</th>
              <td>{inteiro.format(marketplaces[nome].pedidos)}</td>
              <td>{inteiro.format(marketplaces[nome].unidades)}</td>
              <td>{dinheiro.format(marketplaces[nome].faturamento)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {truncado && (
        <p className="cds-cv-aviso">
          O período tem mais dados do que couberam nesta leitura. Os números acima descrevem o que
          foi lido, não o período inteiro.
        </p>
      )}
    </div>
  );
}

function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cds-cv-numero">
      <dt>{rotulo}</dt>
      <dd>{valor}</dd>
    </div>
  );
}

const css = `
  .cds-cv {
    margin-top: ${ESPACO.md}px;
    padding-top: ${ESPACO.md}px;
    border-top: 1px solid ${CROMO.bordaSutil};
    display: grid;
    gap: ${ESPACO.sm}px;
  }
  .cds-cv-form { display: grid; gap: ${ESPACO.sm}px; justify-items: start; }
  .cds-cv-campos { display: flex; flex-wrap: wrap; gap: ${ESPACO.sm}px; }
  .cds-cv-campo { display: grid; gap: ${ESPACO.xs}px; }
  .cds-cv-rotulo {
    font: 600 11px/1.6 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-cv-entrada {
    padding: 6px ${ESPACO.sm}px;
    font: 400 13px/1.5 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-cv-entrada:disabled { opacity: 0.5; cursor: not-allowed; }
  .cds-cv-botao {
    padding: ${ESPACO.sm}px ${ESPACO.lg}px;
    font: 600 13px/1.3 ${FONTE.interface};
    color: ${CROMO.texto};
    background: ${CROMO.acentoFundo};
    border: 1px solid ${CROMO.acentoBorda};
    border-radius: ${RAIO.controle}px;
    cursor: pointer;
  }
  .cds-cv-botao:disabled { opacity: 0.5; cursor: not-allowed; }
  .cds-cv-nota, .cds-cv-detalhe, .cds-cv-periodo {
    margin: 0;
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-cv-aviso {
    margin: 0;
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.acento};
  }
  .cds-cv-execucao { display: grid; gap: ${ESPACO.sm}px; }
  .cds-cv-status {
    margin: 0;
    font: 400 13px/1.5 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-cv-resultado { display: grid; gap: ${ESPACO.md}px; }
  .cds-cv-numeros { display: flex; flex-wrap: wrap; gap: ${ESPACO.lg}px; margin: 0; }
  .cds-cv-numero { display: grid; gap: 2px; }
  .cds-cv-numero dt {
    font: 600 11px/1.6 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-cv-numero dd {
    margin: 0;
    font: 700 15px/1.3 ${FONTE.palco};
    color: ${CROMO.texto};
  }
  .cds-cv-tabela { width: 100%; border-collapse: collapse; }
  .cds-cv-legenda {
    text-align: left;
    padding-bottom: ${ESPACO.xs}px;
    font: 600 11px/1.6 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }
  .cds-cv-tabela th, .cds-cv-tabela td {
    text-align: left;
    padding: ${ESPACO.xs}px ${ESPACO.sm}px;
    border-top: 1px solid ${CROMO.bordaSutil};
    font: 400 12px/1.5 ${FONTE.interface};
    color: ${CROMO.texto};
  }
`;
