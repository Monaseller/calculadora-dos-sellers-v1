"use client";

/**
 * Visao Geral do agente.
 *
 * ── A regra que governa esta tela ───────────────────────────────────
 *
 * Ela mistura, na mesma pagina, dado que existe de verdade (identidade,
 * operacao, instrucoes) com resumos de coisas que ainda nao tem onde ser
 * gravadas (conexoes, funcoes, autonomia, custo). Isso e util e e
 * perigoso pelo mesmo motivo: fica tudo com a mesma cara.
 *
 * Por isso TODO bloco carrega uma etiqueta de procedencia. Uma
 * configuracao simulada nunca aparece com o mesmo peso visual de uma
 * configuracao persistida — se aparecesse, a tela viraria uma promessa
 * de algo que o backend nao cumpre.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { rotuloDe, type AparenciaAgente } from "@/lib/ia/estados";
import { DESCRICAO_TIPO, ROTULO_PROCEDENCIA, VOCABULARIO_AUTONOMIA, type Procedencia } from "@/lib/ia/conceitos";
import { MOCK_CONEXOES, MOCK_FUNCOES, MOCK_PERMISSOES } from "@/lib/ia/mocks";
import { formatarInstante, tarefaAtual, tituloDaTarefa, ultimaAtividade } from "@/lib/ia/tarefas";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado, { corDaAparencia } from "@/components/ia/BadgeEstado";

export default function VisaoGeral({
  agente,
  aparencia,
  tarefas,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  tarefas: readonly TarefaUI[];
}) {
  const atual = tarefaAtual(tarefas);
  const ultima = ultimaAtividade(tarefas);
  const concedidas = MOCK_PERMISSOES.filter((p) => p.concedida);

  return (
    <div className="cds-ia-vg">
      <style>{css}</style>

      <Bloco titulo="Identidade" procedencia="disponivel">
        <Linha rotulo="Nome" valor={agente.nome} />
        <Linha rotulo="Tipo" valor={agente.tipo} />
        <Linha rotulo="Função" valor={DESCRICAO_TIPO[agente.tipo]} />
        <div className="cds-ia-vg-linha">
          <span className="cds-ia-vg-rotulo">Estado</span>
          <span>
            <BadgeEstado aparencia={aparencia} />
          </span>
        </div>
        <Linha
          rotulo="Operação"
          valor={aparencia.foraDeOperacao ? "Fora de operação" : "Ativo"}
        />
      </Bloco>

      <Bloco titulo="Operação" procedencia="disponivel">
        {atual ? (
          <>
            <Linha rotulo="Tarefa atual" valor={tituloDaTarefa(atual)} />
            <div className="cds-ia-vg-linha">
              <span className="cds-ia-vg-rotulo">Progresso</span>
              <span style={{ flex: 1 }}>
                <span
                  role="progressbar"
                  aria-valuenow={atual.progresso}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Progresso da tarefa atual: ${atual.progresso} por cento`}
                  className="cds-ia-vg-trilho"
                >
                  <span
                    className="cds-ia-vg-barra"
                    style={{ width: `${atual.progresso}%`, background: corDaAparencia(aparencia) }}
                  />
                </span>
                <span className="cds-ia-vg-pct">{atual.progresso}%</span>
              </span>
            </div>
          </>
        ) : (
          <Linha rotulo="Tarefa atual" valor="Nenhuma tarefa em andamento" />
        )}
        <Linha rotulo="Última atividade" valor={formatarInstante(ultima)} />
        <Linha rotulo="Tarefas registradas" valor={String(tarefas.length)} />
      </Bloco>

      <Bloco titulo="Configuração" procedencia="disponivel">
        {agente.instrucoes ? (
          <p className="cds-ia-vg-instrucoes">{agente.instrucoes}</p>
        ) : (
          <p className="cds-ia-vg-vazio">
            Nenhuma instrução definida. Instruções orientam como o agente trabalha — elas não
            concedem permissão para nada.
          </p>
        )}
      </Bloco>

      <Bloco titulo="Conexões" procedencia="simulado">
        <ul className="cds-ia-vg-lista">
          {MOCK_CONEXOES.map((c) => (
            <li key={c.id}>
              <strong>{c.rotulo}</strong> — {c.conta}
            </li>
          ))}
        </ul>
        <p className="cds-ia-vg-nota">
          Nada registra hoje qual agente usa qual conta. Esta lista é ilustrativa.
        </p>
      </Bloco>

      <Bloco titulo="Funções e autonomia" procedencia="em_breve">
        <ul className="cds-ia-vg-lista">
          {concedidas.map((p) => {
            const funcao = MOCK_FUNCOES.find((f) => f.id === p.funcaoId);
            if (!funcao) return null;
            return (
              <li key={p.funcaoId}>
                <strong>{funcao.rotulo}</strong>
                {" — "}
                {VOCABULARIO_AUTONOMIA[p.autonomia].rotulo}
                {funcao.procedencia === "em_breve" && (
                  <span className="cds-ia-vg-inline"> (função ainda não existe)</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="cds-ia-vg-nota">
          Não há onde gravar permissão ou autonomia. Nenhuma decisão desta lista está persistida.
        </p>
      </Bloco>

      <Bloco titulo="Custo de IA" procedencia="em_breve">
        <p className="cds-ia-vg-vazio">
          As chamadas de IA já são registradas com modelo, tokens, tempo e custo — mas ainda não
          existe leitura por dono. Nenhum número é exibido aqui porque um número aproximado seria
          pior que nenhum.
        </p>
      </Bloco>
    </div>
  );
}

function Bloco({
  titulo,
  procedencia,
  children,
}: {
  titulo: string;
  procedencia: Procedencia;
  children: React.ReactNode;
}) {
  return (
    <section className={`cds-ia-vg-bloco cds-ia-proc-${procedencia}`}>
      <header className="cds-ia-vg-cabecalho">
        <h3 className="cds-ia-vg-titulo">{titulo}</h3>
        <span className={`cds-ia-vg-proc cds-ia-proc-tag-${procedencia}`}>
          {ROTULO_PROCEDENCIA[procedencia]}
        </span>
      </header>
      {children}
    </section>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cds-ia-vg-linha">
      <span className="cds-ia-vg-rotulo">{rotulo}</span>
      <span className="cds-ia-vg-valor">{valor}</span>
    </div>
  );
}

const css = `
  .cds-ia-vg {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 16px;
    align-items: start;
  }
  .cds-ia-vg-bloco {
    padding: 18px;
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    background: ${CROMO.fundoCard};
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  /* Procedencia tambem muda a MOLDURA, nao so a etiqueta: quem bate o
     olho percebe que o bloco tem outro peso antes de ler o rotulo. */
  .cds-ia-proc-simulado, .cds-ia-proc-em_breve {
    border-style: dashed;
    background: transparent;
  }
  .cds-ia-vg-cabecalho {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; margin-bottom: 14px;
  }
  .cds-ia-vg-titulo { margin: 0; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; color: ${CROMO.textoFraco}; }
  .cds-ia-vg-proc { padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; white-space: nowrap; }
  .cds-ia-proc-tag-disponivel { border: 1px solid rgba(0,217,126,.35); color: #00D97E; }
  .cds-ia-proc-tag-simulado { border: 1px solid ${CROMO.acentoBorda}; color: ${CROMO.acento}; }
  .cds-ia-proc-tag-em_breve { border: 1px solid ${CROMO.borda}; color: ${CROMO.textoFraco}; }
  .cds-ia-proc-tag-nao_configurado { border: 1px solid ${CROMO.borda}; color: ${CROMO.textoFraco}; }

  .cds-ia-vg-linha { display: flex; gap: 12px; align-items: baseline; padding: 5px 0; }
  .cds-ia-vg-rotulo { flex: 0 0 118px; color: ${CROMO.textoFraco}; font-size: 12px; }
  .cds-ia-vg-valor { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .cds-ia-vg-trilho { display: block; height: 8px; border-radius: 999px; background: rgba(255,255,255,.06); overflow: hidden; }
  .cds-ia-vg-barra { display: block; height: 100%; }
  .cds-ia-vg-pct { display: block; margin-top: 4px; font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-vg-instrucoes { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cds-ia-vg-vazio, .cds-ia-vg-nota { margin: 10px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-vg-vazio { margin-top: 0; }
  .cds-ia-vg-lista { margin: 0; padding-left: 18px; }
  .cds-ia-vg-lista li { margin-bottom: 4px; }
  .cds-ia-vg-inline { color: ${CROMO.textoFraco}; font-size: 12px; }
`;
