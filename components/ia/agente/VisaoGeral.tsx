"use client";

/**
 * Visao Geral do agente.
 *
 * ── A regra que governa esta tela ───────────────────────────────────
 *
 * Ela mistura, na mesma pagina, dado que existe de verdade (identidade,
 * instrucoes, estado) com superficies cuja fonte ainda nao esta ligada
 * a esta tela. Isso e util e e perigoso pelo mesmo motivo: fica tudo
 * com a mesma cara.
 *
 * Por isso TODO bloco carrega uma etiqueta de procedencia, e a etiqueta
 * muda a moldura, nao so o texto.
 *
 * ── O que mudou na SKILL-1D.ui-real-state-B ─────────────────────────
 *
 * Tres blocos deixaram de exibir conteudo ilustrativo:
 *
 *   Conexoes  listava `Loja Exemplo`, `Segunda conta` — contas que nao
 *             existem, ao lado do nome e das instrucoes REAIS do
 *             agente do dono. Enquanto tudo na tela era simulado isso
 *             se sustentava; com identidade real ao lado, a lista
 *             passou a parecer configuracao deste agente.
 *   Funcoes   mesma coisa, com `Consultar vendas` e companhia.
 *   Operacao  nao listava ficcao: derivava de uma lista de tarefas
 *             VAZIA e fixa no codigo, e anunciava o resultado como
 *             "Dado real". "Tarefas registradas: 0" nao e uma leitura
 *             que deu zero — e a ausencia de leitura. As duas coisas
 *             sao indistinguiveis na tela e opostas no significado.
 *
 * Os tres viraram `em_breve`, que e a unica coisa verdadeira que esta
 * tela sabe dizer sobre eles hoje: a fonte nao esta ligada aqui.
 *
 * O que NAO foi feito, e e a regra desta frente: nenhum deles virou
 * "Nenhuma conexao atribuida" ou "Nenhuma funcao habilitada". Isso
 * seria um hardcode hoje verdadeiro — e no dia em que a fonte chegasse
 * com conteudo, a frase continuaria la, errada e convincente.
 */
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import { type AparenciaAgente } from "@/lib/ia/estados";
import { DESCRICAO_TIPO, ROTULO_PROCEDENCIA, type Procedencia } from "@/lib/ia/conceitos";
import type { AgenteUI, TarefaUI } from "@/lib/ia/contratos";
import BadgeEstado from "@/components/ia/BadgeEstado";

export default function VisaoGeral({
  agente,
  aparencia,
  tarefas,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  /**
   * Recebido e deliberadamente NAO lido. O container continua passando
   * a lista (vazia, fixa) porque nao existe leitura real de tarefas; ler
   * daqui produziria "0 tarefas" com cara de consulta. A prop fica no
   * contrato para o dia em que houver fonte — remover e recolocar
   * depois obrigaria a mexer no container por motivo nenhum.
   */
  tarefas: readonly TarefaUI[];
}) {
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

      <Bloco titulo="Trabalho" procedencia="em_breve">
        <p className="cds-ia-vg-vazio">
          Tarefa em andamento, progresso e última atividade aparecerão aqui quando esta tela
          passar a ler as tarefas do agente. Nenhum número é exibido por enquanto — dizer
          &ldquo;0 tarefas&rdquo; afirmaria uma consulta que ainda não acontece.
        </p>
      </Bloco>

      <Bloco titulo="Conexões" procedencia="em_breve">
        <p className="cds-ia-vg-vazio">
          Quais contas conectadas este agente usa ainda não é lido nesta tela. Quando for, cada
          conexão aparecerá com a conta e o estado dela — e o agente continuará sabendo apenas
          que a conexão existe, nunca a credencial.
        </p>
      </Bloco>

      <Bloco titulo="Funções e autonomia" procedencia="em_breve">
        <p className="cds-ia-vg-vazio">
          O que este agente pode fazer, e com quanta autonomia, ainda não é lido nesta tela.
          Nenhuma função é listada aqui até que exista fonte — uma lista de exemplo seria
          indistinguível de uma configuração deste agente.
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
  .cds-ia-vg-instrucoes { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cds-ia-vg-vazio { margin: 0; font-size: 12px; color: ${CROMO.textoFraco}; }
`;
