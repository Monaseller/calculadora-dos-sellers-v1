"use client";

/**
 * Aba Tarefas — a unica superficie desta fase inteiramente ancorada em
 * schema real.
 *
 * ── Lista, e nao tabela ─────────────────────────────────────────────
 *
 * Sao 12 campos por tarefa, alguns longos (mensagem de erro). Uma tabela
 * com 12 colunas nao cabe em nenhuma largura util e vira rolagem
 * horizontal permanente. Cada tarefa e um cartao: o titulo e o estado em
 * cima, os tempos embaixo, o erro quando existir.
 *
 * ── Status de TAREFA, nao estado de AGENTE ──────────────────────────
 *
 * Este componente NAO importa `lib/ia/estados.ts`. Sao seis status de
 * tarefa, com vocabulario proprio em `lib/ia/tarefas.ts`. Misturar os
 * dois faria "Concluída" (uma tarefa) e "Concluído" (um agente, por 8
 * segundos) parecerem a mesma coisa.
 *
 * ── Aprovacao nao acontece aqui ─────────────────────────────────────
 *
 * `aguardando_aprovacao` mostra que a tarefa esta parada e aponta para
 * `/ia/aprovacoes`. Nao ha Aprovar nem Recusar: o fluxo nao existe, e um
 * botao inerte no meio da lista seria confundido com um botao quebrado.
 */
import { CROMO, CORES_ESTADO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  VOCABULARIO_STATUS_TAREFA,
  duracaoMs,
  esperaNaFilaMs,
  formatarDuracao,
  formatarInstante,
  maisRecentesPrimeiro,
  mensagemDeErro,
  pareceOrfa,
  podeTentarNovamente,
  tituloDaTarefa,
} from "@/lib/ia/tarefas";
import type { StatusTarefaUI, TarefaUI } from "@/lib/ia/contratos";
import EstadoVazio from "@/components/ia/EstadoVazio";

/** Cor por status de TAREFA. Reusa a paleta de estado onde o significado
 *  e o mesmo, e cinza onde nao ha equivalente (fila, cancelada). */
const COR_STATUS: Record<StatusTarefaUI, string> = {
  pendente: CORES_ESTADO.ocioso,
  rodando: CORES_ESTADO.trabalhando,
  aguardando_aprovacao: CORES_ESTADO.aguardando_aprovacao,
  concluido: CORES_ESTADO.concluido,
  erro: CORES_ESTADO.erro,
  cancelado: "#5b6577",
};

export default function ListaTarefas({
  tarefas,
  agoraMs,
}: {
  tarefas: readonly TarefaUI[];
  agoraMs: number;
}) {
  if (tarefas.length === 0) {
    return (
      <EstadoVazio
        titulo="Nenhuma tarefa ainda"
        descricao="Quando este agente receber trabalho, cada tarefa aparecerá aqui com estado, progresso, tempos e tentativas."
      />
    );
  }

  const ordenadas = maisRecentesPrimeiro(tarefas);

  return (
    <>
      <style>{css}</style>
      <ul className="cds-ia-tarefas">
        {ordenadas.map((t) => (
          <li key={t.id}>
            <Cartao tarefa={t} agoraMs={agoraMs} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Cartao({ tarefa, agoraMs }: { tarefa: TarefaUI; agoraMs: number }) {
  const vocab = VOCABULARIO_STATUS_TAREFA[tarefa.status];
  const cor = COR_STATUS[tarefa.status];
  const erro = mensagemDeErro(tarefa);
  const orfa = pareceOrfa(tarefa, agoraMs);
  const emAndamento = tarefa.concluido_em === null && tarefa.status === "rodando";

  return (
    <article className="cds-ia-tarefa" style={{ borderLeftColor: cor }}>
      <header className="cds-ia-tarefa-topo">
        <h3 className="cds-ia-tarefa-titulo">{tituloDaTarefa(tarefa)}</h3>
        <span className="cds-ia-tarefa-status" style={{ borderColor: cor, color: cor }}>
          <span aria-hidden="true">{vocab.icone}</span> {vocab.rotulo}
        </span>
      </header>

      {tarefa.progresso > 0 && (
        <div
          role="progressbar"
          aria-valuenow={tarefa.progresso}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Progresso: ${tarefa.progresso} por cento`}
          className="cds-ia-tarefa-trilho"
        >
          <div className="cds-ia-tarefa-barra" style={{ width: `${tarefa.progresso}%`, background: cor }} />
        </div>
      )}

      <dl className="cds-ia-tarefa-campos">
        <Campo rotulo="Criada" valor={formatarInstante(tarefa.criado_em)} />
        <Campo rotulo="Iniciada" valor={formatarInstante(tarefa.iniciado_em)} />
        <Campo rotulo="Concluída" valor={formatarInstante(tarefa.concluido_em)} />
        <Campo
          rotulo={emAndamento ? "Em execução há" : "Duração"}
          valor={formatarDuracao(duracaoMs(tarefa, agoraMs))}
        />
        <Campo rotulo="Espera na fila" valor={formatarDuracao(esperaNaFilaMs(tarefa))} />
        <Campo rotulo="Tentativa" valor={`${tarefa.tentativas} de ${tarefa.max_tentativas}`} />
      </dl>

      {tarefa.status === "aguardando_aprovacao" && (
        <p className="cds-ia-tarefa-aviso cds-ia-tarefa-aprovacao">
          Parada aguardando decisão humana — o executor não retoma tarefas neste estado.{" "}
          <a href="/ia/aprovacoes">Ver aprovações</a>. O fluxo de aprovar e recusar ainda não existe.
        </p>
      )}

      {orfa && (
        <p className="cds-ia-tarefa-aviso">
          Sem sinal de vida há mais de 5 minutos. Nesse ponto o executor considera a tarefa
          abandonada e a devolve para a fila.
        </p>
      )}

      {(erro !== null || tarefa.erro_tipo !== null) && (
        <div className="cds-ia-tarefa-erro">
          <span className="cds-ia-tarefa-erro-tag" aria-hidden="true">
            ✕
          </span>
          <div>
            <strong>Falhou{tarefa.erro_tipo ? ` — ${tarefa.erro_tipo}` : ""}.</strong>
            {erro && <span> {erro}</span>}
            <div className="cds-ia-tarefa-retry">
              {podeTentarNovamente(tarefa)
                ? "Ainda há tentativas disponíveis."
                : "Tentativas esgotadas."}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function Campo({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cds-ia-tarefa-campo">
      <dt>{rotulo}</dt>
      <dd>{valor}</dd>
    </div>
  );
}

const css = `
  .cds-ia-tarefas { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .cds-ia-tarefa {
    padding: ${ESPACO.lg}px;
    background: ${CROMO.fundoCard};
    border: 1px solid ${CROMO.borda};
    border-left: 3px solid transparent;
    border-radius: ${RAIO.card}px;
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-tarefa-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
  }
  .cds-ia-tarefa-titulo { margin: 0; font-size: 14px; font-weight: 700; }
  .cds-ia-tarefa-status {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border: 1px solid; border-radius: 999px;
    font-size: 11px; font-weight: 700; white-space: nowrap;
  }
  .cds-ia-tarefa-trilho {
    margin-top: 10px; height: 6px; border-radius: 999px;
    background: rgba(255,255,255,.06); overflow: hidden;
  }
  .cds-ia-tarefa-barra { height: 100%; }

  .cds-ia-tarefa-campos {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 10px 16px;
    margin: 14px 0 0;
  }
  .cds-ia-tarefa-campo dt { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-tarefa-campo dd { margin: 2px 0 0; font-size: 13px; }

  .cds-ia-tarefa-aviso {
    margin: 12px 0 0; padding: 10px 12px;
    border: 1px solid ${CROMO.borda}; border-radius: ${RAIO.controle}px;
    font-size: 12px; color: ${CROMO.textoFraco};
  }
  .cds-ia-tarefa-aprovacao { border-color: rgba(240,180,41,.35); }
  .cds-ia-tarefa-aviso a { color: ${CROMO.acento}; }

  .cds-ia-tarefa-erro {
    display: flex; gap: 10px; align-items: flex-start;
    margin: 12px 0 0; padding: 10px 12px;
    border: 1px solid rgba(240,106,106,.35); border-radius: ${RAIO.controle}px;
    font-size: 12px;
  }
  .cds-ia-tarefa-erro-tag { color: ${CORES_ESTADO.erro}; font-weight: 700; }
  .cds-ia-tarefa-retry { margin-top: 4px; color: ${CROMO.textoFraco}; }
`;
