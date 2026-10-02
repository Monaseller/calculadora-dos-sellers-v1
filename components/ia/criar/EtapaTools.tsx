"use client";

/**
 * Etapa 4 — Tools (F8.3-C2). A mesma experiencia da aba Tools da pagina
 * Agentes: busca local no catalogo real (`TOOL_PACKS` via `filtrarTools`,
 * que exclui os packs de API — o Mercado Livre NUNCA aparece aqui),
 * "Neste agente" e "Disponíveis", nivel e adicionar/remover pelos
 * contratos de sempre (`adicionarPackAoAgente` / `removerPackDoAgente`).
 */
import { useState } from "react";
import { TOOL_PACKS, packPorId } from "@/lib/agentes/factory/catalogo-ui";
import type { AtivacaoDoAgenteUI } from "@/lib/ia/agentes-http";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import { iconeDoPack } from "@/lib/ia/icones-ferramentas";
import { filtrarTools, projetarCapacidades } from "@/lib/ia/agentes-gestao";
import { IconeBusca } from "@/components/ia/agentes/icones";
import { SeletorDeNivel, comoEscrita, cx, type Escrever } from "@/components/ia/criar/comum";
import estilos from "@/components/ia/criar/criar.module.css";

export default function EtapaTools({
  agenteId, ativacao, ocupado, escrever,
}: {
  agenteId: string;
  ativacao: AtivacaoDoAgenteUI;
  ocupado: boolean;
  escrever: Escrever;
}) {
  const [termo, setTermo] = useState("");
  const cap = projetarCapacidades(ativacao);
  const visiveis = filtrarTools(termo, TOOL_PACKS);
  const ids = new Set(cap.tools.map((t) => t.id));
  const adicionadas = cap.tools.filter((t) => visiveis.some((p) => p.id === t.id));
  const disponiveis = visiveis.filter((p) => !ids.has(p.id));
  const buscando = termo.trim() !== "";

  return (
    <>
      <div className={estilos.busca}>
        <span className={estilos.buscaIcone}><IconeBusca tamanho={15} /></span>
        <input type="search" className={estilos.entrada} value={termo} onChange={(e) => setTermo(e.target.value)}
          placeholder="Buscar Tools..." aria-label="Buscar Tools" />
      </div>

      <h3 className={estilos.secaoTitulo}>
        Neste agente ({buscando ? `${adicionadas.length} de ${cap.tools.length}` : cap.tools.length})
      </h3>
      {cap.tools.length === 0 ? (
        <p className={estilos.vazio}>Nenhuma Tool adicionada.</p>
      ) : adicionadas.length === 0 ? (
        <p className={estilos.dica}>Nenhuma Tool deste agente corresponde à busca.</p>
      ) : (
        <ul className={estilos.itens} aria-label="Tools neste agente">
          {adicionadas.map((f) => (
            <li key={f.id} className={cx(estilos.item, estilos.itemAtivo)}>
              <span className={estilos.itemIcone} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={iconeDoPack(f.id)} alt="" />
              </span>
              <div className={estilos.itemTexto}>
                <span className={estilos.itemNome}>
                  {f.nome}
                  <span className={cx(estilos.selo, estilos.seloOk)}>● Adicionada</span>
                  {!f.completo && <span className={cx(estilos.selo, estilos.seloAtencao)}>● Falta definir a permissão</span>}
                </span>
                <span className={estilos.itemSub}>{packPorId(f.id)?.descricao ?? ""}</span>
              </div>
              <div className={estilos.itemAcoes}>
                <SeletorDeNivel
                  rotulo={`Quando o agente pode usar ${f.nome}`}
                  valor={f.completo ? f.nivel : null} desabilitado={ocupado}
                  aoMudar={(n) => void escrever(() => comoEscrita(adicionarPackAoAgente(agenteId, f.id, n)),
                    "Não foi possível salvar a permissão.")}
                />
                <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                  onClick={() => void escrever(() => removerPackDoAgente(agenteId, f.id), "Não foi possível remover esta Tool.")}>
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className={estilos.secaoTitulo}>Disponíveis ({disponiveis.length})</h3>
      {disponiveis.length === 0 ? (
        <p className={estilos.dica}>{buscando
          ? `Nenhuma Tool disponível para “${termo.trim()}”.`
          : "Todas as Tools disponíveis já estão neste agente."}</p>
      ) : (
        <ul className={estilos.itens} aria-label="Tools disponíveis">
          {disponiveis.map((p) => (
            <li key={p.id} className={cx(estilos.item, estilos.itemFraco)}>
              <span className={estilos.itemIcone} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={iconeDoPack(p.id)} alt="" />
              </span>
              <div className={estilos.itemTexto}>
                <span className={estilos.itemNome}>{p.nome}</span>
                <span className={estilos.itemSub}>{p.descricao}</span>
              </div>
              <div className={estilos.itemAcoes}>
                <button type="button" className={estilos.botao} disabled={ocupado}
                  onClick={() => void escrever(() => comoEscrita(adicionarPackAoAgente(agenteId, p.id, null)),
                    "Não foi possível adicionar esta Tool.")}>
                  + Adicionar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
