"use client";

/**
 * Shell da pagina individual do agente: identidade no topo, abas, painel.
 *
 * ── Por que Client Component ────────────────────────────────────────
 *
 * O estado do agente depende do relogio (o flash transitorio de
 * conclusao) e as tarefas mockadas sao ancoradas na montagem. Ler o
 * relogio no servidor e de novo no cliente produziria HTML divergente —
 * mesmo motivo do escritorio, e por isso a mesma solucao: `ancoraMs`
 * fixa os dados, `agoraMs` anda.
 *
 * ── Uma so maquina de estados ───────────────────────────────────────
 *
 * A identidade no topo NAO calcula estado proprio: chama
 * `aparenciaDoAgente`, que delega a precedencia a `derivarStatusAgente`
 * do backend. Nenhuma tela desta area tem permissao para inventar um
 * segundo entendimento de "o que este agente esta fazendo".
 *
 * ── Container do detalhe REAL, desde a SKILL-1D.ui-consumer-C ───────
 *
 * Recebe apenas o `agenteId` da rota e busca DUAS coisas em paralelo,
 * pelo unico modulo de rede da area: a lista do dono (de onde sai a
 * identidade do agente) e o diagnostico dele. Paralelo porque as duas
 * leituras sao independentes — encadea-las so somaria espera.
 *
 * "Agente nao encontrado" nasce de UMA fonte: a lista autenticada do
 * proprio usuario, sem o agente pedido. NUNCA do diagnostico vazio —
 * diagnostico vazio significa "nenhuma Skill a avaliar", e o servidor
 * responde exatamente igual para agente inexistente e para agente de
 * outro dono, de proposito. Ler existencia ali seria desfazer no
 * navegador a indistinguibilidade que a API construiu.
 *
 * As TAREFAS continuam sem fonte real e por isso sao sempre a lista
 * vazia: associar as simuladas a um agente de verdade misturaria duas
 * verdades na mesma tela.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ABAS, PENDENCIA_ABA, type AbaId } from "@/lib/ia/abas";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { DESCRICAO_TIPO } from "@/lib/ia/conceitos";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente } from "@/lib/ia/estados";
import {
  listarAgentes,
  obterDiagnostico,
  type RespostaAgentes,
  type RespostaDiagnostico,
} from "@/lib/ia/agentes-http";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import { Personagem } from "@/components/ia/office/Estacao";
import BadgeEstado from "@/components/ia/BadgeEstado";
import EstadoVazio from "@/components/ia/EstadoVazio";
import EmBreve from "@/components/ia/EmBreve";
import AbasAgente from "@/components/ia/agente/AbasAgente";
import VisaoGeral from "@/components/ia/agente/VisaoGeral";
import ListaTarefas from "@/components/ia/agente/ListaTarefas";
import AbaConexoes from "@/components/ia/agente/AbaConexoes";
import AbaFuncoes from "@/components/ia/agente/AbaFuncoes";
import AbaPermissoes from "@/components/ia/agente/AbaPermissoes";

/** Sem leitura real de tarefas, ninguem tem tarefa. */
const NENHUMA_TAREFA: readonly TarefaUI[] = [];

export default function PaginaAgente({ agenteId, aba }: { agenteId: string; aba: AbaId }) {
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [lista, setLista] = useState<RespostaAgentes | null>(null);
  const [diagnostico, setDiagnostico] = useState<RespostaDiagnostico | null>(null);

  useEffect(() => {
    const inicio = Date.now();
    setAgoraMs(inicio);
    const t = window.setTimeout(() => setAgoraMs(Date.now()), JANELA_CONCLUIDO_MS + 250);
    return () => window.clearTimeout(t);
  }, []);

  // As duas leituras EM PARALELO, e reiniciadas quando o agente muda. O
  // `AbortController` garante que a resposta de um agente anterior nao
  // sobrescreva a tela de outro.
  useEffect(() => {
    const controlador = new AbortController();
    setLista(null);
    setDiagnostico(null);
    void Promise.all([
      listarAgentes(controlador.signal),
      obterDiagnostico(agenteId, controlador.signal),
    ]).then(([rLista, rDiagnostico]) => {
      if (controlador.signal.aborted) return;
      setLista(rLista);
      setDiagnostico(rDiagnostico);
    });
    return () => controlador.abort();
  }, [agenteId]);

  const agente: AgenteUI | null =
    lista !== null && lista.estado === "ok"
      ? (lista.agentes.find((a) => a.id === agenteId) ?? null)
      : null;

  const tarefas = NENHUMA_TAREFA;

  const aparencia = useMemo(
    () => (agoraMs === null || agente === null ? null : aparenciaDoAgente(agente, tarefas, agoraMs)),
    [agente, tarefas, agoraMs]
  );

  if (lista === null) {
    return <p className="cds-ia-carregando">Carregando…</p>;
  }

  // Sessao expirada e falha de leitura NAO podem virar "nao encontrado":
  // as tres coisas pedem acoes diferentes do dono.
  if (lista.estado === "nao_autenticado") {
    return (
      <EstadoVazio
        titulo="Sessão expirada"
        descricao="Entre novamente para ver este agente."
        acao={{ href: "/login", rotulo: "Entrar" }}
      />
    );
  }

  if (lista.estado === "falha") {
    return (
      <EstadoVazio
        titulo="Não foi possível carregar"
        descricao="Houve uma falha ao buscar seus agentes. Tente novamente em instantes."
        acao={{ href: "/ia/agentes", rotulo: "Ver todos os agentes" }}
      />
    );
  }

  // Lista OK e sem este id: o agente nao e do dono da sessao, ou nao
  // existe. As duas situacoes sao a MESMA resposta, de proposito.
  if (agente === null) {
    return (
      <EstadoVazio
        titulo="Agente não encontrado"
        descricao="Nenhum agente corresponde a este endereço. Ele pode ter sido removido, ou o link pode estar incorreto."
        acao={{ href: "/ia/agentes", rotulo: "Ver todos os agentes" }}
      />
    );
  }

  return (
    <>
      <style>{css}</style>

      <p className="cds-ia-volta">
        <Link href="/ia/agentes">← Todos os agentes</Link>
      </p>

      <header className="cds-ia-cabecalho">
        <div className="cds-ia-cabecalho-figura" aria-hidden="true">
          <Personagem
            agente={agente}
            sentado={false}
            apagado={aparencia?.foraDeOperacao ?? false}
            escala={0.9}
          />
        </div>

        <div className="cds-ia-cabecalho-texto">
          <h2 className="cds-ia-nome">{agente.nome}</h2>
          <p className="cds-ia-funcao">
            {DESCRICAO_TIPO[agente.tipo]} · <span className="cds-ia-tipo">{agente.tipo}</span>
          </p>
        </div>

        <div className="cds-ia-cabecalho-estado">
          {aparencia ? (
            <>
              <BadgeEstado aparencia={aparencia} />
              {aparencia.foraDeOperacao && (
                <span className="cds-ia-fora">Este agente está desligado</span>
              )}
            </>
          ) : (
            <span className="cds-ia-carregando">Carregando estado…</span>
          )}
        </div>
      </header>

      <AbasAgente agenteId={agente.id} ativa={aba} />

      <section className="cds-ia-painel" aria-label={rotuloDaAba(aba)}>
        {aba === "visao-geral" && aparencia && (
          <>
            <VisaoGeral agente={agente} aparencia={aparencia} tarefas={tarefas} />
            <PainelDiagnostico resposta={diagnostico} />
          </>
        )}

        {aba === "tarefas" && agoraMs !== null && (
          <ListaTarefas tarefas={tarefas} agoraMs={agoraMs} />
        )}

        {(aba === "visao-geral" || aba === "tarefas") && agoraMs === null && (
          <p className="cds-ia-carregando">Carregando…</p>
        )}

        {/* As tres abas de configuracao nao dependem do relogio: elas
            desenham configuracao, nao estado em andamento. */}
        {aba === "conexoes" && <AbaConexoes />}
        {aba === "funcoes" && <AbaFuncoes />}
        {aba === "permissoes" && <AbaPermissoes />}

        {abaPendente(aba) && (
          <EmBreve
            titulo={rotuloDaAba(aba)}
            descricao={DESCRICAO_ABA[aba]}
            pendencia={PENDENCIA_ABA[aba]}
          />
        )}
      </section>
    </>
  );
}

/**
 * O diagnostico das Skills do agente — LISTA, nunca um resumo.
 *
 * Cada item e um par `(skillId, versao)`: duas versoes da mesma Skill
 * podem estar associadas ao mesmo agente, e escolher uma delas aqui
 * apagaria a diferenca que o servidor faz questao de manter. Por isso
 * nao ha `diagnosticos[0]` e nao ha agrupamento por `skillId`.
 *
 * `semSelecao` aparece em bloco PROPRIO. Ele nao e uma pendencia do
 * diagnostico: e "existe um requisito e ninguem escolheu a loja ainda",
 * coisa que pede uma acao diferente de "a conta escolhida nao serve".
 * Traduzi-lo para uma pendencia inventaria um estado que o dominio nao
 * tem.
 */
function PainelDiagnostico({ resposta }: { resposta: RespostaDiagnostico | null }) {
  if (resposta === null) return <p className="cds-ia-carregando">Carregando diagnóstico…</p>;

  if (resposta.estado === "nao_autenticado") {
    return <p className="cds-ia-carregando">Sua sessão expirou; entre novamente.</p>;
  }
  if (resposta.estado === "entrada_invalida") {
    return <p className="cds-ia-carregando">Não foi possível diagnosticar este agente.</p>;
  }
  if (resposta.estado === "falha") {
    return <p className="cds-ia-carregando">Não foi possível carregar o diagnóstico.</p>;
  }

  const { diagnosticos, semSelecao } = resposta;

  return (
    <section className="cds-ia-diag" aria-label="Diagnóstico das Skills">
      <h3 className="cds-ia-diag-titulo">Skills</h3>

      {diagnosticos.length === 0 ? (
        <p className="cds-ia-carregando">Nenhuma Skill associada a este agente.</p>
      ) : (
        <ul className="cds-ia-diag-lista">
          {diagnosticos.map((item) => (
            <li key={`${item.skillId}@${item.versao}`} className="cds-ia-diag-item">
              <span className="cds-ia-diag-nome">
                {item.skillId} <span className="cds-ia-diag-versao">v{item.versao}</span>
              </span>
              <span className="cds-ia-diag-estado">
                {item.diagnostico.pronto ? "Pronta" : item.diagnostico.estadoGeral}
              </span>
            </li>
          ))}
        </ul>
      )}

      {semSelecao.length > 0 && (
        <p className="cds-ia-diag-selecao">
          {semSelecao.length === 1
            ? "1 conexão exigida ainda não tem loja escolhida."
            : `${semSelecao.length} conexões exigidas ainda não têm loja escolhida.`}
        </p>
      )}
    </section>
  );
}

function rotuloDaAba(aba: AbaId): string {
  return ABAS.find((a) => a.id === aba)?.rotulo ?? "Agente";
}

/** Chave de `PENDENCIA_ABA`, derivada da propria lista de abas. */
type AbaPendente = Extract<(typeof ABAS)[number], { implementada: false }>["id"];

/**
 * Predicado com type guard: quem entra aqui e, para o `tsc`, uma aba
 * pendente — e so entao pode indexar `PENDENCIA_ABA`. Promover uma aba a
 * implementada quebra a compilacao se ela continuar na lista de
 * pendencias, em vez de renderizar "Em breve" para algo ja pronto.
 */
function abaPendente(aba: AbaId): aba is AbaPendente {
  return ABAS.find((a) => a.id === aba)?.implementada === false;
}

/** O que cada superficie VAI ser. Fica ao lado da pendencia, para a tela
 *  dizer as duas coisas: o destino e o que falta para chegar la. */
const DESCRICAO_ABA: Record<AbaPendente, string> = {
  chat: "Conversar diretamente com este agente: pedir análises, dar orientações e entender o que ele encontrou.",
  memoria: "Instruções fixas, preferências e o que o agente aprendeu ao longo do tempo.",
  custos: "Consumo de IA deste agente por período, modelo e provedor.",
};

const css = `
  .cds-ia-volta { margin: 0 0 ${ESPACO.md}px; font: 13px/1.4 ${FONTE.interface}; }
  .cds-ia-volta a { color: ${CROMO.textoFraco}; text-decoration: none; }
  .cds-ia-volta a:hover { color: ${CROMO.texto}; }
  .cds-ia-volta a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }

  .cds-ia-cabecalho {
    display: flex; align-items: center; gap: ${ESPACO.lg}px; flex-wrap: wrap;
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-cabecalho-figura { flex-shrink: 0; }
  .cds-ia-cabecalho-texto { flex: 1; min-width: 180px; }
  .cds-ia-cabecalho-estado { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

  .cds-ia-nome { margin: 0; font: 800 20px/1.2 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-funcao { margin: 4px 0 0; font: 13px/1.5 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-tipo { font-family: ${FONTE.palco}; font-size: 12px; }
  .cds-ia-fora { font: 11px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-carregando { font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco}; margin: 0; }

  .cds-ia-painel { padding-top: ${ESPACO.xl}px; }

  .cds-ia-diag { margin-top: ${ESPACO.xl}px; }
  .cds-ia-diag-titulo {
    margin: 0 0 ${ESPACO.md}px;
    font: 700 13px/1.4 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-diag-lista { list-style: none; margin: 0; padding: 0; display: grid; gap: ${ESPACO.sm}px; }
  .cds-ia-diag-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${ESPACO.md}px;
    padding: ${ESPACO.md}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.controle}px;
  }
  .cds-ia-diag-nome { font: 13px/1.4 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-diag-versao { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-diag-estado { font: 11px/1.4 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-diag-selecao {
    margin: ${ESPACO.md}px 0 0;
    font: 12px/1.5 ${FONTE.interface};
    color: ${CROMO.textoFraco};
  }

  @media (max-width: 640px) {
    .cds-ia-cabecalho-estado { align-items: flex-start; width: 100%; }
  }
`;
