"use client";

/**
 * Aba Permissoes e autonomia.
 *
 * Responde a uma pergunta so: "das funcoes que o sistema conhece, quais
 * este agente pode usar, e com qual autonomia?"
 *
 * ── Nada aqui grava, e a tela diz isso ──────────────────────────────
 *
 * Nao existe onde persistir a decisao. Entao a representacao e estatica
 * (ver `SeletorAutonomia`) e o aviso e o primeiro elemento da tela, nao
 * uma nota de rodape que ninguem le. Um controle que parece funcionar e
 * nao grava e pior que controle nenhum.
 *
 * ── Um unico fluxo de aprovacao ─────────────────────────────────────
 *
 * "Exige aprovação" aponta para `/ia/aprovacoes`. Nao ha Aprovar nem
 * Recusar aqui: criar uma segunda porta de aprovacao dentro da aba faria
 * existirem dois fluxos concorrentes para a mesma decisao.
 */
import Link from "next/link";
import { CROMO, ESPACO, FONTE, RAIO } from "@/lib/ia/design";
import {
  ROTULO_ACESSO,
  ROTULO_PROCEDENCIA,
  VOCABULARIO_NIVEL,
  funcaoDisponivel,
  permitida,
} from "@/lib/ia/conceitos";
import { MOCK_AVISO, MOCK_FUNCOES, MOCK_NIVEL_DA_FUNCAO } from "@/lib/ia/mocks";
import SeletorAutonomia from "@/components/ia/capabilities/SeletorAutonomia";

export default function AbaPermissoes() {
  return (
    <section aria-label="Permissões e autonomia deste agente">
      <style>{css}</style>

      <header className="cds-ia-ap-topo">
        <div>
          <h3 className="cds-ia-ap-titulo">Permissões e autonomia</h3>
          <p className="cds-ia-ap-sub">
            Para cada função, o nível define se o agente pode usá-la e se precisa pedir
            autorização antes. Nenhuma decisão desta tela é gravada — não existe, ainda, onde
            registrar quem decidiu e quando.
          </p>
        </div>
        <span className="cds-ia-ap-simulado">{MOCK_AVISO}</span>
      </header>

      <ul className="cds-ia-ap-lista">
        {MOCK_FUNCOES.map((f) => {
          const nivel = MOCK_NIVEL_DA_FUNCAO(f.id);
          const vocab = VOCABULARIO_NIVEL[nivel];
          const idRotulo = `cds-ia-perm-${f.id.replace(/\./g, "-")}`;

          return (
            <li key={f.id} className="cds-ia-ap-item">
              <header className="cds-ia-ap-item-topo">
                <div>
                  <h4 id={idRotulo} className="cds-ia-ap-nome">
                    {f.rotulo}
                  </h4>
                  <p className="cds-ia-ap-meta">
                    {ROTULO_ACESSO[f.acesso].rotulo}
                    {" · "}
                    {funcaoDisponivel(f) ? "Disponível no sistema" : "Ainda não oferecida"}
                    {" · "}
                    {permitida({ nivel }) ? "Permitida" : "Bloqueada"}
                  </p>
                </div>
                <span className="cds-ia-ap-nivel">{vocab.rotulo}</span>
              </header>

              <SeletorAutonomia nivel={nivel} idRotulo={idRotulo} />

              {nivel === "aprovacao" && (
                <p className="cds-ia-ap-nota">
                  Quando executada, a tarefa vai parar aguardando decisão humana.{" "}
                  <Link href="/ia/aprovacoes">Ver aprovações</Link> — o fluxo ainda não existe.
                </p>
              )}

              {nivel === "bloqueado" && (
                <p className="cds-ia-ap-nota">
                  Bloqueada não é o mesmo que indisponível: a função pode existir no sistema e
                  ainda assim não ser entregue a este agente.
                </p>
              )}

              <p className="cds-ia-ap-proc">
                {ROTULO_PROCEDENCIA[MOCK_FUNCOES.find((x) => x.id === f.id)!.procedencia]}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const css = `
  .cds-ia-ap-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.lg}px;
  }
  .cds-ia-ap-titulo { margin: 0; font: 800 15px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-ap-sub {
    margin: 6px 0 0; max-width: 66ch;
    font: 13px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-simulado {
    flex-shrink: 0;
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.acentoBorda}; background: ${CROMO.acentoFundo};
    color: ${CROMO.acento}; font: 700 11px/1.6 ${FONTE.interface};
  }
  .cds-ia-ap-lista { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
  .cds-ia-ap-item {
    padding: ${ESPACO.lg}px;
    border: 1px solid ${CROMO.borda}; border-radius: ${RAIO.card}px;
    background: ${CROMO.fundoCard};
  }
  .cds-ia-ap-item-topo {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: ${ESPACO.md}px;
  }
  .cds-ia-ap-nome { margin: 0; font: 800 14px/1.3 ${FONTE.interface}; color: ${CROMO.texto}; }
  .cds-ia-ap-meta { margin: 3px 0 0; font: 12px/1.5 ${FONTE.interface}; color: ${CROMO.textoFraco}; }
  .cds-ia-ap-nivel {
    flex-shrink: 0; padding: 3px 10px; border-radius: 999px;
    border: 1px solid ${CROMO.borda}; color: ${CROMO.texto};
    font: 700 11px/1.6 ${FONTE.interface}; white-space: nowrap;
  }
  .cds-ia-ap-nota {
    margin: ${ESPACO.md}px 0 0;
    font: 12px/1.6 ${FONTE.interface}; color: ${CROMO.textoFraco};
  }
  .cds-ia-ap-nota a { color: ${CROMO.acento}; }
  .cds-ia-ap-nota a:focus-visible { outline: 2px solid ${CROMO.acento}; outline-offset: 3px; }
  .cds-ia-ap-proc {
    margin: ${ESPACO.md}px 0 0; padding-top: 10px;
    border-top: 1px solid ${CROMO.bordaSutil};
    font: 10px/1.4 ${FONTE.interface}; letter-spacing: 1px; color: ${CROMO.textoFraco};
  }
`;
