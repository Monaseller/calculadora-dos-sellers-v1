"use client";

/**
 * Office V1 — o host do chat REAL abaixo do escritorio.
 *
 * ── A mesma semantica do Workspace, sem tocar no chat ───────────────
 *
 * `conversa`, `abrirNova` e `geracao` fazem aqui exatamente o que fazem
 * em `Workspace.tsx`: "Nova conversa" zera a conversa, pede uma nova e
 * remonta o chat pela `key`. `ChatDoAgente` nao muda uma linha.
 *
 * ── Uma conversa nunca atravessa de agente ──────────────────────────
 *
 * Quem monta este host passa `key={agenteId}`: trocar de agente
 * DESMONTA o host inteiro, e `conversa`/`abrirNova`/`geracao` nascem
 * limpos. A conversa do agente A nao tem caminho para aparecer no B.
 *
 * `memo` + `aoTrocarConversa` estavel: o Escritorio re-renderiza a cada
 * refresh de 5 s, e um callback novo a cada render faria o efeito de
 * abertura do chat reler as mensagens sem motivo.
 *
 * ── Agente inativo nao conversa ─────────────────────────────────────
 *
 * Fora de operacao, o chat nem e montado: a tela diz o estado e leva a
 * configuracao, em vez de abrir uma conversa que falharia no envio.
 */
import { memo, useCallback, useState } from "react";
import Link from "next/link";
import { ChatDoAgente } from "@/components/ia/factory/ChatDoAgente";
import { ROTULO_FORA_DE_OPERACAO } from "@/lib/ia/estados";
import estilos from "@/components/ia/office/office-v1.module.css";

function OfficeChatHost({
  agenteId,
  nome,
  ativo,
}: {
  agenteId: string;
  nome: string;
  ativo: boolean;
}) {
  const [conversa, setConversa] = useState<string | null>(null);
  const [abrirNova, setAbrirNova] = useState(false);
  const [geracao, setGeracao] = useState(0);

  const aoTrocarConversa = useCallback((id: string) => {
    setConversa(id);
    setAbrirNova(false);
  }, []);

  const configurar = `/ia/agentes/${agenteId}/configurar`;

  if (!ativo) {
    return (
      <section aria-label={`Conversa com ${nome}`} className={estilos.chat}>
        <div className={estilos.chatInativo} role="status">
          <p>
            <strong>{nome}</strong> está {ROTULO_FORA_DE_OPERACAO.toLowerCase()} e não responde
            mensagens.
          </p>
          <Link href={configurar} className={estilos.botao}>
            <span aria-hidden="true">⚙</span>
            Configurar agente
          </Link>
        </div>
      </section>
    );
  }

  return (
    // ── Uma janela, uma barra (F8.1-B3) ──────────────────────────────
    //
    // A barra de cima e UMA so: titulo e "Nova conversa" vem daqui, e o
    // botao "Arquivos" e o do proprio chat. Este cabecalho fica sobreposto
    // a linha de Arquivos do chat, que o CSS do Office transforma na barra
    // (`--cds-chat-barra-*`). Assim "Arquivos" continua sendo o fluxo real
    // do chat, sem prop nova e sem mover logica.
    <section aria-label={`Conversa com ${nome}`} className={estilos.chatJanela}>
      <div className={estilos.chatCabecalho}>
        <div className={estilos.chatIdentidade}>
          <span aria-hidden="true" className={estilos.chatAvatar}>
            {nome.charAt(0).toUpperCase()}
          </span>
          <h2 className={estilos.chatTitulo}>Conversa com {nome}</h2>
        </div>
        <button
          type="button"
          className={`${estilos.botao} ${estilos.chatNova}`}
          onClick={() => {
            setConversa(null);
            setAbrirNova(true);
            setGeracao((g) => g + 1);
          }}
        >
          Nova conversa
        </button>
      </div>
      <div className={estilos.chatCorpo}>
        <ChatDoAgente
          key={`${agenteId}:${geracao}`}
          agenteId={agenteId}
          conversaId={conversa}
          abrirNova={abrirNova}
          aoTrocarConversa={aoTrocarConversa}
        />
      </div>
    </section>
  );
}

export default memo(OfficeChatHost);
