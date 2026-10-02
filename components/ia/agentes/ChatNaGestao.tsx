"use client";

/**
 * O chat REAL do agente selecionado na pagina Agentes — F8.3-C1.4.
 *
 * Host FINO. O chat e o `ChatDoAgente` de sempre (envio, polling,
 * reconciliacao, arquivos, aprovacoes, TextoDoAgente, cards de vendas):
 * nada daqui envia, le ou interpreta mensagem. A semantica e a MESMA do
 * Workspace e do host do Escritorio:
 *
 *   Nova conversa -> conversa=null, abrirNova=true, geracao+1
 *   chat          -> key `${agenteId}:${geracao}`
 *   aoTrocarConversa -> conversa=id, abrirNova=false (callback estavel)
 *
 * Quem monta passa `key={agenteId}`: trocar de agente DESMONTA este host,
 * e a conversa do agente anterior nao tem caminho para aparecer no novo.
 *
 * "Limpar conversa" (do v0) NAO existe aqui: o unico contrato do servidor
 * e ARQUIVAR (que nao e limpar), e nao ha transporte de cliente para ele.
 * A acao real e honesta e "Nova conversa".
 *
 * Agente inativo nao conversa: o chat nem e montado.
 */
import { memo, useCallback, useState } from "react";
import { ChatDoAgente } from "@/components/ia/factory/ChatDoAgente";
import type { AparenciaAgente } from "@/lib/ia/estados";
import { StatusDoAgente } from "@/components/ia/agentes/CartaoDeAgente";
import { IconeNovaConversa } from "@/components/ia/agentes/icones";
import estilos from "@/components/ia/agentes/agentes.module.css";

function ChatNaGestao({
  agenteId, nome, ativo, aparencia,
}: {
  agenteId: string;
  nome: string;
  ativo: boolean;
  aparencia: AparenciaAgente;
}) {
  const [conversa, setConversa] = useState<string | null>(null);
  const [abrirNova, setAbrirNova] = useState(false);
  const [geracao, setGeracao] = useState(0);

  const aoTrocarConversa = useCallback((id: string) => {
    setConversa(id);
    setAbrirNova(false);
  }, []);

  return (
    <section aria-labelledby="ag-chat-titulo" className={estilos.chat}>
      <header className={estilos.chatTopo}>
        <h2 id="ag-chat-titulo" className={estilos.secaoTitulo}>Chat do agente</h2>
        <StatusDoAgente aparencia={aparencia} />
        {ativo && (
          <button
            type="button"
            className={`${estilos.botao} ${estilos.chatAcao}`}
            onClick={() => {
              setConversa(null);
              setAbrirNova(true);
              setGeracao((g) => g + 1);
            }}
          >
            <IconeNovaConversa tamanho={15} />
            Nova conversa
          </button>
        )}
      </header>
      {ativo ? (
        <div className={estilos.chatCorpo}>
          <ChatDoAgente
            key={`${agenteId}:${geracao}`}
            agenteId={agenteId}
            conversaId={conversa}
            abrirNova={abrirNova}
            aoTrocarConversa={aoTrocarConversa}
          />
        </div>
      ) : (
        <p className={estilos.chatInativo} role="status">
          <strong>{nome}</strong> está fora de operação e não responde mensagens. Ative o agente
          na aba <strong>Status</strong> da configuração abaixo.
        </p>
      )}
    </section>
  );
}

export default memo(ChatNaGestao);
