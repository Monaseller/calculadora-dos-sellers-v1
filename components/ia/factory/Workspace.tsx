"use client";

/**
 * O WORKSPACE do agente — a tela que abre ao clicar num agente (§34).
 *
 * ── Chat dominante, configuracao fora ───────────────────────────────
 *
 * Clicar num agente nao abre painel de administracao: abre a conversa
 * com ele. Tudo que e configuracao mora no wizard, atras de um link.
 *
 * O cabecalho e deliberadamente magro — nome, estado e tres acoes. A
 * versao com metricas, custo e diagnostico ja existe, nas abas
 * (`?aba=`), e continua a um clique. O que ela nao pode fazer e ocupar
 * a tela de quem so quer perguntar uma coisa.
 *
 * ── Um agente inativo nao conversa ──────────────────────────────────
 *
 * Se o agente esta em rascunho, o lugar dele e o wizard, e a tela diz
 * isso em vez de abrir um chat que falharia no envio. O aviso leva para
 * a configuracao; nao tenta adivinhar o que falta (quem sabe disso e a
 * rota de ativacao, e a etapa 11 mostra).
 *
 * A rede, como em todo componente desta area, e de
 * `lib/ia/agentes-http.ts` — aqui nao ha `fetch` nem endereco de API.
 */
import { useEffect, useState } from "react";
import Link from "next/link";

import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";
import { Aviso, Botao, Etiqueta, TAMANHO } from "@/components/ui/Primitivas";
import { ChatDoAgente } from "@/components/ia/factory/ChatDoAgente";
import { lerAtivacaoDoAgente, type AtivacaoDoAgenteUI } from "@/lib/ia/agentes-http";

export function Workspace({ agenteId }: { agenteId: string }) {
  const [resumo, setResumo] = useState<AtivacaoDoAgenteUI | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [naoEncontrado, setNaoEncontrado] = useState(false);
  // Trocar de conversa remonta o chat: `key` muda, estado nasce limpo.
  const [conversa, setConversa] = useState<string | null>(null);
  const [geracao, setGeracao] = useState(0);

  useEffect(() => {
    let vivo = true;
    (async () => {
      const r = await lerAtivacaoDoAgente(agenteId);
      if (!vivo) return;
      // "Nao encontrado" vem de UMA fonte: a rota, que responde igual
      // para agente inexistente e para agente de outro dono.
      if (r.estado === "nao_encontrado") setNaoEncontrado(true);
      else if (r.estado === "ok") setResumo(r.dados);
      setCarregando(false);
    })();
    return () => { vivo = false; };
  }, [agenteId]);

  if (carregando) {
    return (
      <p style={{ color: CROMO.textoFraco, fontSize: TAMANHO.corpo, padding: ESPACO.xl }}>
        Carregando…
      </p>
    );
  }

  if (naoEncontrado || resumo === null) {
    return (
      <div style={{ padding: ESPACO.xl, maxWidth: 560 }}>
        <Aviso tom="atencao">
          {naoEncontrado
            ? "Este agente não foi encontrado."
            : "Não foi possível carregar este agente."}
        </Aviso>
        <div style={{ marginTop: ESPACO.lg }}>
          <Link href="/ia/agentes" style={{ color: CROMO.acento, fontSize: TAMANHO.corpo }}>
            ← Voltar para os agentes
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column",
      // A conversa e o conteudo; ela ocupa o que sobra da altura.
      height: "calc(100vh - 120px)", minHeight: 420,
    }}>
      {/* ── Cabecalho compacto ── */}
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: ESPACO.md, flexWrap: "wrap",
        padding: `0 0 ${ESPACO.md}px`,
        borderBottom: `1px solid ${CROMO.bordaSutil}`,
        marginBottom: ESPACO.md,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: ESPACO.sm, minWidth: 0 }}>
          <Link href="/ia/agentes" aria-label="Voltar para os agentes"
            style={{ color: CROMO.textoFraco, fontSize: TAMANHO.corpo, textDecoration: "none" }}>
            ←
          </Link>
          <h1 style={{
            margin: 0, fontSize: TAMANHO.titulo, fontWeight: 600, color: CROMO.texto,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {resumo.nome}
          </h1>
          <Etiqueta tom={resumo.ativo ? "ok" : "atencao"}>
            {resumo.ativo ? "Ativo" : "Rascunho"}
          </Etiqueta>
        </div>

        <div style={{ display: "flex", gap: ESPACO.sm, flexWrap: "wrap" }}>
          <Botao tom="secundario" onClick={() => { setConversa(null); setGeracao((g) => g + 1); }}>
            Nova conversa
          </Botao>
          <Link href={`/ia/agentes/${agenteId}/configurar`} style={{ textDecoration: "none" }}>
            <Botao tom="sutil">Configurar</Botao>
          </Link>
          {/* As abas antigas continuam existindo, e continuam alcancaveis.
              Elas nao sao o caminho principal — sao o aprofundamento. */}
          <Link href={`/ia/agentes/${agenteId}?aba=visao-geral`} style={{ textDecoration: "none" }}>
            <Botao tom="sutil">Detalhes</Botao>
          </Link>
        </div>
      </header>

      {!resumo.ativo && (
        <div style={{ marginBottom: ESPACO.md }}>
          <Aviso tom="atencao">
            Este agente ainda é um rascunho e não responde.{" "}
            <Link href={`/ia/agentes/${agenteId}/configurar`} style={{ color: CROMO.acento }}>
              Terminar a configuração
            </Link>
          </Aviso>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, borderRadius: RAIO.card, overflow: "hidden" }}>
        <ChatDoAgente
          key={`${agenteId}:${geracao}`}
          agenteId={agenteId}
          conversaId={conversa}
          aoTrocarConversa={setConversa}
        />
      </div>
    </div>
  );
}
