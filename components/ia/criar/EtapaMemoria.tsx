"use client";

/**
 * Etapa 5 — Memoria (F8.3-C2). Os contratos provados na pagina Agentes:
 *
 *   automatica   `agentes.memoria_ativa` via `definirMemoriaDoAgente`;
 *                motor por `lerMemoriaDoAgente` (quem le e o fluxo)
 *   fixadas      `/memorias`: listar, criar, PATCH `conteudo` | `ativo`,
 *                DELETE — limite do dominio (`MAX_CONTEUDO_DA_MEMORIA`)
 *
 * Texto digitado e ainda nao salvo (nova memoria ou memoria em edicao) e
 * avisado ao fluxo como rascunho: trocar de etapa pede confirmacao.
 */
import { useEffect, useState } from "react";
import { MAX_CONTEUDO_DA_MEMORIA } from "@/lib/agentes/memorias/tipos";
import {
  alterarMemoriaDoAgente, criarMemoriaDoAgente, definirMemoriaDoAgente, removerMemoriaDoAgente,
  type AtivacaoDoAgenteUI, type EstadoDaMemoriaUI, type MemoriaDoAgenteUI,
} from "@/lib/ia/agentes-http";
import { Interruptor, cx, type Escrever } from "@/components/ia/criar/comum";
import estilos from "@/components/ia/criar/criar.module.css";

export default function EtapaMemoria({
  agenteId, ativacao, motor, memorias, falhaMemorias, ocupado, escrever, avisar, aoAlterarRascunho,
}: {
  agenteId: string;
  ativacao: AtivacaoDoAgenteUI;
  motor: EstadoDaMemoriaUI | null;
  memorias: readonly MemoriaDoAgenteUI[] | null;
  falhaMemorias: boolean;
  ocupado: boolean;
  escrever: Escrever;
  avisar: (mensagem: string) => void;
  aoAlterarRascunho: (tem: boolean) => void;
}) {
  const [novaMemoria, setNovaMemoria] = useState("");
  const [editando, setEditando] = useState<{ id: string; texto: string } | null>(null);
  const [excluindo, setExcluindo] = useState<string | null>(null);

  const emEdicao = editando === null ? null : memorias?.find((m) => m.id === editando.id) ?? null;
  const temRascunho = novaMemoria.trim() !== "" ||
    (editando !== null && emEdicao !== null && editando.texto.trim() !== emEdicao.conteudo);
  useEffect(() => { aoAlterarRascunho(temRascunho); }, [temRascunho, aoAlterarRascunho]);
  useEffect(() => () => aoAlterarRascunho(false), [aoAlterarRascunho]);

  async function criar() {
    const texto = novaMemoria.trim();
    if (texto === "") return;
    const ok = await escrever(() => criarMemoriaDoAgente(agenteId, { conteudo: texto, ordem: (memorias?.length ?? 0) + 1 }),
      "Não foi possível adicionar a memória.");
    if (ok) { setNovaMemoria(""); avisar("Memória adicionada."); }
  }

  async function salvarEdicao() {
    if (editando === null) return;
    const texto = editando.texto.trim();
    if (texto === "") return;
    const ok = await escrever(() => alterarMemoriaDoAgente(agenteId, editando.id, { conteudo: texto }),
      "Não foi possível salvar a memória.");
    if (ok) { setEditando(null); avisar("Memória atualizada."); }
  }

  const ativas = memorias?.filter((m) => m.ativo).length ?? 0;

  return (
    <>
      <div className={estilos.bloco}>
        <div className={estilos.blocoLinha}>
          <div>
            <p className={estilos.secaoTitulo}>Memória automática</p>
            <p className={estilos.dica}>
              Permite que este agente preserve contexto útil entre conversas. A memória de um agente
              nunca é vista por outro.
            </p>
          </div>
          <span className={estilos.rotuloInterruptor}>
            {ativacao.memoriaAtiva ? "Ativada" : "Desativada"}
            <Interruptor
              ligado={ativacao.memoriaAtiva} rotulo="Memória automática"
              desabilitado={ocupado || motor?.motorConfigurado === false}
              aoMudar={(v) => void escrever(() => definirMemoriaDoAgente(agenteId, v), "Não foi possível alterar a memória.")}
            />
          </span>
        </div>
        <span className={cx(estilos.selo,
          motor === null ? estilos.seloFraco : motor.motorConfigurado ? estilos.seloOk : estilos.seloAtencao)}>
          ● {motor === null ? "Verificando o motor de memória…"
            : motor.motorConfigurado ? "Disponível neste ambiente" : "Não configurada neste ambiente"}
        </span>
      </div>

      <div className={estilos.bloco} aria-label="Memórias fixadas">
        <div>
          <p className={estilos.secaoTitulo}>
            Memórias fixadas {memorias !== null && `(${ativas} ativa${ativas === 1 ? "" : "s"})`}
          </p>
          <p className={estilos.dica}>
            Instruções que você escreve à mão e o agente sempre considera.
          </p>
        </div>
        <label className={estilos.campo}>
          <span className={estilos.rotulo}>Nova memória</span>
          <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={3} style={{ minHeight: 84 }}
            value={novaMemoria} maxLength={MAX_CONTEUDO_DA_MEMORIA}
            placeholder="Ex.: Quando eu pedir resumo financeiro, mostre o saldo primeiro."
            onChange={(e) => setNovaMemoria(e.target.value)} />
          <span className={estilos.contador}>{novaMemoria.length}/{MAX_CONTEUDO_DA_MEMORIA}</span>
        </label>
        <div>
          <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
            disabled={ocupado || novaMemoria.trim() === ""} onClick={() => void criar()}>
            + Adicionar memória
          </button>
        </div>

        {memorias === null ? (
          <p className={estilos.dica}>{falhaMemorias ? "Não foi possível carregar as memórias fixadas agora." : "Carregando memórias…"}</p>
        ) : memorias.length === 0 ? (
          <p className={estilos.vazio}>Nenhuma memória fixada.</p>
        ) : (
          <ul className={estilos.itens}>
            {memorias.map((m) => {
              const editandoEsta = editando?.id === m.id;
              return (
                <li key={m.id} className={cx(estilos.item, m.ativo && estilos.itemAtivo)}>
                  <div className={estilos.itemTexto}>
                    {editandoEsta ? (
                      <label className={estilos.campo}>
                        <span className={estilos.rotulo}>Editar memória</span>
                        <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={3} style={{ minHeight: 84 }}
                          value={editando.texto} maxLength={MAX_CONTEUDO_DA_MEMORIA}
                          onChange={(e) => setEditando({ id: m.id, texto: e.target.value })} />
                        <span className={estilos.contador}>{editando.texto.length}/{MAX_CONTEUDO_DA_MEMORIA}</span>
                      </label>
                    ) : (
                      <>
                        <span className={estilos.itemNome}>
                          {m.ativo
                            ? <span className={cx(estilos.selo, estilos.seloOk)}>● Ativa</span>
                            : <span className={cx(estilos.selo, estilos.seloFraco)}>Desativada</span>}
                        </span>
                        <span className={estilos.itemSub} style={{ whiteSpace: "pre-wrap" }}>{m.conteudo}</span>
                      </>
                    )}
                  </div>
                  <div className={estilos.itemAcoes}>
                    {editandoEsta ? (
                      <>
                        <button type="button" className={estilos.botao} disabled={ocupado} onClick={() => setEditando(null)}>
                          Cancelar
                        </button>
                        <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                          disabled={ocupado || editando.texto.trim() === "" || editando.texto.trim() === m.conteudo}
                          onClick={() => void salvarEdicao()}>
                          Salvar
                        </button>
                      </>
                    ) : excluindo === m.id ? (
                      <>
                        <button type="button" className={estilos.botao} disabled={ocupado} onClick={() => setExcluindo(null)}>
                          Cancelar
                        </button>
                        <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                          onClick={() => { setExcluindo(null); void escrever(() => removerMemoriaDoAgente(agenteId, m.id),
                            "Não foi possível excluir a memória."); }}>
                          Confirmar exclusão
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className={estilos.botao} disabled={ocupado || editando !== null}
                          onClick={() => setEditando({ id: m.id, texto: m.conteudo })}>
                          Editar
                        </button>
                        <button type="button" className={estilos.botao} disabled={ocupado}
                          onClick={() => void escrever(() => alterarMemoriaDoAgente(agenteId, m.id, { ativo: !m.ativo }),
                            "Não foi possível alterar a memória.")}>
                          {m.ativo ? "Desativar" : "Ativar"}
                        </button>
                        <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                          onClick={() => setExcluindo(m.id)}>
                          Excluir
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
