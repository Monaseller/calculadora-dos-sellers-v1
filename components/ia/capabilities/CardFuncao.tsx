/**
 * Card de uma funcao (capability, no vocabulario tecnico).
 *
 * ── As duas perguntas que este card responde, separadas ─────────────
 *
 *   DISPONIBILIDADE  o sistema sabe fazer isso?      -> Disponível / Em breve
 *   PERMISSAO        este agente pode usar?          -> Permitida / Bloqueada
 *
 * Sao independentes, e confundi-las e o erro mais provavel desta tela.
 * Uma funcao pode existir no sistema e estar bloqueada para o agente; e
 * pode estar "permitida" numa configuracao que ainda nao roda porque a
 * funcao nem existe. Os dois selos ficam lado a lado, com palavras
 * diferentes — nunca um so status combinando os dois.
 *
 * ── Leitura x Acao ──────────────────────────────────────────────────
 *
 * Sinalizado com icone E texto. Nunca so cor: quem nao distingue verde
 * de vermelho precisa ler "Ação" e "Risco alto" do mesmo jeito.
 */
import { CORES_ESTADO, CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  ROTULO_ACESSO,
  ROTULO_PROCEDENCIA,
  ROTULO_RISCO,
  VOCABULARIO_NIVEL,
  funcaoDisponivel,
  permitida,
  type ConexaoUI,
  type FuncaoUI,
  type NivelAutonomia,
} from "@/lib/ia/conceitos";

export default function CardFuncao({
  funcao,
  nivel,
  conexao,
}: {
  funcao: FuncaoUI;
  nivel: NivelAutonomia;
  conexao: ConexaoUI | null;
}) {
  const disponivel = funcaoDisponivel(funcao);
  const podeUsar = permitida({ nivel });
  const acesso = ROTULO_ACESSO[funcao.acesso];

  return (
    <article className="cds-ia-fn">
      <style>{css}</style>

      <header className="cds-ia-fn-topo">
        <h3 className="cds-ia-fn-titulo">{funcao.rotulo}</h3>

        <div className="cds-ia-fn-selos">
          {/* Selo 1: o sistema sabe fazer? */}
          <span className={disponivel ? "cds-ia-selo cds-ia-selo-ok" : "cds-ia-selo"}>
            {disponivel ? "Disponível" : "Em breve"}
          </span>
          {/* Selo 2: este agente pode? Palavra diferente, de proposito. */}
          <span className={podeUsar ? "cds-ia-selo cds-ia-selo-permitida" : "cds-ia-selo cds-ia-selo-bloqueada"}>
            {podeUsar ? "Permitida" : "Bloqueada"}
          </span>
        </div>
      </header>

      <p className="cds-ia-fn-meta">
        <span className={funcao.acesso === "escrita" ? "cds-ia-fn-acao" : undefined}>
          <span aria-hidden="true">{acesso.icone}</span> {acesso.rotulo}
        </span>
        {" · "}
        {ROTULO_RISCO[funcao.risco]}
      </p>

      <p className="cds-ia-fn-descricao">{funcao.descricao}</p>

      <dl className="cds-ia-fn-campos">
        <div>
          <dt>Conexão necessária</dt>
          <dd>
            {funcao.conexaoNecessaria === null
              ? "Nenhuma — usa dados do próprio CDS"
              : conexao
                ? `${conexao.rotulo} · ${conexao.conta}`
                : "Conexão não atribuída a este agente"}
          </dd>
        </div>
        <div>
          <dt>Autonomia configurada</dt>
          <dd>{VOCABULARIO_NIVEL[nivel].rotulo}</dd>
        </div>
      </dl>

      {funcao.acesso === "escrita" && (
        <p className="cds-ia-fn-aviso">
          Esta função altera algo fora do CDS. Ações externas só serão habilitadas com
          estratégia de repetição segura — o executor pode tentar a mesma tarefa mais de uma vez.
        </p>
      )}

      <footer className="cds-ia-fn-rodape">{ROTULO_PROCEDENCIA[funcao.procedencia]}</footer>
    </article>
  );
}

const css = `
  .cds-ia-fn {
    display: flex; flex-direction: column;
    padding: ${ESPACO.lg}px;
    border: 1px solid ${CROMO.borda};
    border-radius: ${RAIO.card}px;
    background: ${CROMO.fundoCard};
    font: 13px/1.6 ${FONTE.interface};
    color: ${CROMO.texto};
  }
  .cds-ia-fn-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 10px; flex-wrap: wrap;
  }
  .cds-ia-fn-titulo { margin: 0; font-size: 15px; font-weight: 800; }
  .cds-ia-fn-selos { display: flex; gap: 6px; flex-wrap: wrap; }
  .cds-ia-selo {
    padding: 2px 9px; border-radius: 999px;
    border: 1px solid ${CROMO.borda}; color: ${CROMO.textoFraco};
    font-size: 10px; font-weight: 700; white-space: nowrap;
  }
  .cds-ia-selo-ok { border-color: rgba(0,217,126,.35); color: ${CORES_ESTADO.concluido}; }
  .cds-ia-selo-permitida { border-color: rgba(79,209,197,.4); color: ${CORES_ESTADO.trabalhando}; }
  .cds-ia-selo-bloqueada { border-color: rgba(240,106,106,.35); color: ${CORES_ESTADO.erro}; }

  .cds-ia-fn-meta { margin: 10px 0 0; font-size: 12px; color: ${CROMO.textoFraco}; }
  .cds-ia-fn-acao { color: ${CORES_ESTADO.aguardando_aprovacao}; font-weight: 700; }
  .cds-ia-fn-descricao { margin: 8px 0 0; }
  .cds-ia-fn-campos {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 10px 16px; margin: 14px 0 0;
  }
  .cds-ia-fn-campos dt { font-size: 11px; color: ${CROMO.textoFraco}; }
  .cds-ia-fn-campos dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
  .cds-ia-fn-aviso {
    margin: 14px 0 0; padding: 10px 12px;
    border: 1px solid rgba(240,180,41,.3); border-radius: ${RAIO.controle}px;
    font-size: 12px; color: ${CROMO.textoFraco};
  }
  .cds-ia-fn-rodape {
    margin-top: 14px; padding-top: 10px;
    border-top: 1px solid ${CROMO.bordaSutil};
    font-size: 10px; letter-spacing: 1px; color: ${CROMO.textoFraco};
  }
`;
