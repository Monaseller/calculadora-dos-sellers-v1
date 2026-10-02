"use client";

/**
 * Seletor horizontal "Selecionar agente para modificar" — F8.3-C1.4.
 *
 * Le e escreve a MESMA selecao da pagina (`selecionado` em
 * GestaoDeAgentes) — nao guarda estado proprio. Uma linha so, com scroll
 * horizontal proprio quando ha mais agentes que espaco.
 */
import type { AparenciaAgente } from "@/lib/ia/estados";
import type { AgenteUI } from "@/lib/ia/contratos";
import { StatusDoAgente } from "@/components/ia/agentes/CartaoDeAgente";
import IconeDoAgente from "@/components/ia/agentes/IconeDoAgente";
import estilos from "@/components/ia/agentes/agentes.module.css";

export default function SeletorDeAgentes({
  itens, selecionado, aoSelecionar,
}: {
  itens: readonly { agente: AgenteUI; aparencia: AparenciaAgente; usaMercadoLivre: boolean }[];
  selecionado: string | null;
  aoSelecionar: (id: string) => void;
}) {
  return (
    <section aria-labelledby="ag-seletor-titulo" className={estilos.seletor}>
      <div>
        <h2 id="ag-seletor-titulo" className={estilos.secaoTitulo}>Selecionar agente para modificar</h2>
        <p className={estilos.secaoSub}>Clique em um agente abaixo para editar suas configurações.</p>
      </div>
      <ul className={estilos.seletorLista}>
        {itens.map(({ agente, aparencia, usaMercadoLivre }) => {
          const ativo = agente.id === selecionado;
          return (
            <li key={agente.id}>
              <button
                type="button"
                aria-pressed={ativo}
                onClick={() => aoSelecionar(agente.id)}
                className={`${estilos.seletorItem} ${ativo ? estilos.seletorItemAtivo : ""}`}
              >
                <IconeDoAgente tipo={agente.tipo} usaMercadoLivre={usaMercadoLivre} tamanho="md" />
                <span className={estilos.seletorTexto}>
                  <span className={estilos.seletorNome}>{agente.nome}</span>
                  <StatusDoAgente aparencia={aparencia} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
