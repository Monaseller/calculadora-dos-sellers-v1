"use client";

/**
 * O escritorio da CDS IA — home visual da area.
 *
 * ── Office V1: cena, painel e chat ──────────────────────────────────
 *
 * A cena e a imagem aprovada com seis mesas fixas (`OFFICE_SLOTS`, em
 * `OfficeSceneV1.tsx`). A posicao pertence ao CENARIO: nenhum agente
 * carrega `x`/`y`, e nenhuma mesa e reservada por nome. A lista de
 * agentes, em ordem de apresentacao, ocupa as mesas; quem passa da sexta
 * aparece em "Outros agentes", abaixo da cena.
 *
 * Ao lado, o painel do agente selecionado (dados e ferramentas reais) e,
 * abaixo, o `ChatDoAgente` real, num host remontado por agente.
 *
 * ── Por que `agoraMs` vem do cliente, e nao do render ───────────────
 *
 * `concluido` e transitorio: depende de comparar `concluido_em` com o
 * relogio. Ler o relogio durante o SSR e de novo no cliente produziria
 * HTML diferente nos dois lados — erro de hidratacao. Entao o palco so
 * desenha depois da montagem, com um unico `Date.now()`.
 *
 * ── O palco deixou de ser simulado ──────────────────────────────────
 *
 * Ele desenhava `MOCK_AGENTES` e `MOCK_TAREFAS`. Agora le os agentes
 * REAIS do dono e o snapshot operacional de cada um, pela mesma rota
 * autenticada que a lista de agentes usa.
 *
 * O que chega NAO e tarefa: sao `sinais` (status + `concluido_em`) e a
 * `atividade` ja resumida pelo servidor. A derivacao de estado continua
 * inteira do lado do cliente, com `aparenciaDoAgente` — e assim o flash
 * de concluido expira com o relogio de quem olha, sem depender de
 * nenhuma resposta nova.
 *
 * ── O refresh nao e `setInterval` ───────────────────────────────────
 *
 * E `await` seguido de `setTimeout`: o proximo ciclo so e agendado
 * quando o anterior TERMINA. Um intervalo fixo enfileira requisicoes
 * quando a rede fica lenta, e a tela passa a aplicar respostas fora de
 * ordem — o palco piscaria entre dois retratos diferentes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { JANELA_CONCLUIDO_MS, aparenciaDoAgente } from "@/lib/ia/estados";
import { listarAgentesDoEscritorio, type AgenteComSnapshotUI } from "@/lib/ia/agentes-http";
import OfficeSceneV1, { OFFICE_SLOTS, OutrosAgentes } from "@/components/ia/office/OfficeSceneV1";
import OfficeAgentPanelV1 from "@/components/ia/office/OfficeAgentPanelV1";
import OfficeChatHost from "@/components/ia/office/OfficeChatHost";
import VendasAoVivo from "@/components/ia/office/VendasAoVivo";
import estilos from "@/components/ia/office/office-v1.module.css";

/** De quanto em quanto tempo o palco volta a perguntar. */
const INTERVALO_REFRESH_MS = 5_000;

/**
 * O instante em que o proximo flash de `concluido` deixa de valer.
 *
 * ── Por que este calculo existe ─────────────────────────────────────
 *
 * `concluido` e transitorio: `aparenciaDoAgente` compara `concluido_em`
 * com o relogio a CADA render. Se nada provocar um render novo, o flash
 * fica congelado na tela ate o proximo retrato chegar — e o retrato
 * chega de 5 em 5 segundos. Uma tarefa encerrada logo apos uma leitura
 * apagaria com ate 5 s de atraso sobre a janela real.
 *
 * A resposta NAO e perguntar mais vezes. Nada mudou no servidor: quem
 * mudou foi o relogio, e relogio nao se busca pela rede. Entao o palco
 * agenda um despertador LOCAL para o instante exato da fronteira.
 *
 * Devolve `null` quando nao ha nada a expirar — e e por isso que o
 * despertador nao vira um `setInterval` disfarcado: sem flash vivo, nao
 * ha timer nenhum.
 */
function proximaExpiracaoMs(
  agentes: readonly AgenteComSnapshotUI[],
  agoraMs: number
): number | null {
  let proxima: number | null = null;
  for (const item of agentes) {
    for (const sinal of item.sinais) {
      if (sinal.status !== "concluido" || sinal.concluido_em === null) continue;
      const fim = Date.parse(sinal.concluido_em);
      if (Number.isNaN(fim)) continue;
      // A MESMA fronteira de `concluiuRecentemente`: a janela e aberta
      // no fim (`decorrido < JANELA`), entao em `fim + JANELA` o flash
      // ja nao vale. A constante vem de `estados.ts`, dona unica.
      const expira = fim + JANELA_CONCLUIDO_MS;
      if (expira <= agoraMs) continue; // ja expirou: nada a agendar
      if (proxima === null || expira < proxima) proxima = expira;
    }
  }
  return proxima;
}

type EstadoDaLeitura = "carregando" | "ok" | "nao_autenticado" | "falha";

/**
 * Qual agente fica selecionado — F8.3-C1.1.
 *
 * A regra de sempre (o atual, se ainda existe; senao o primeiro), com UMA
 * entrada a mais: `pedido` (o `?agente=` da URL) vale SO na selecao
 * INICIAL (`atual === null`) e SO se o id estiver na lista real. Id
 * inexistente, invalido ou de outro dono simplesmente nao casa, e vale o
 * primeiro — o fallback de sempre.
 */
export function escolherSelecao(
  ids: readonly string[], atual: string | null, pedido: string | null
): string | null {
  if (atual !== null && ids.includes(atual)) return atual;
  if (atual === null && pedido !== null && ids.includes(pedido)) return pedido;
  return ids[0] ?? null;
}

export default function Escritorio() {
  // `agoraMs` avanca a cada leitura: e o que faz o flash de conclusao
  // expirar. Ele nasce `null` para que o primeiro render seja igual nos
  // dois lados da hidratacao — o relogio so e lido depois da montagem.
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  // F8.3-C1.1: `?agente=<id>`, lido UMA vez. Consumido na primeira selecao;
  // depois disso a URL nao manda mais em nada.
  const pedido = useRef<string | null>(
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("agente"));
  const [estado, setEstado] = useState<EstadoDaLeitura>("carregando");
  // O ULTIMO retrato bom. Uma falha de refresh nao o apaga: a tela
  // continua mostrando o que sabe, em vez de piscar para vazio por causa
  // de um Wi-Fi que caiu por dois segundos.
  const [agentes, setAgentes] = useState<readonly AgenteComSnapshotUI[]>([]);

  useEffect(() => {
    // UMA unica linha de execucao. `vivo` fecha a porta do estado: uma
    // resposta que chega depois da desmontagem nao tem mais onde
    // escrever, e nao ha `setState` em componente morto.
    let vivo = true;
    let agendamento: number | null = null;
    const controlador = new AbortController();

    const ciclo = async () => {
      const resposta = await listarAgentesDoEscritorio(controlador.signal);
      if (!vivo) return;

      if (resposta.estado === "ok") {
        setAgentes(resposta.agentes);
        setAgoraMs(Date.now());
        setEstado("ok");
      } else if (resposta.estado === "nao_autenticado") {
        setEstado("nao_autenticado");
      } else {
        // Falha de refresh PRESERVA o retrato anterior; falha na
        // primeira leitura nao tem retrato para preservar e assume o
        // erro. Em nenhum dos dois casos a tela cai para dado simulado.
        setEstado((anterior) => (anterior === "ok" ? "ok" : "falha"));
      }

      // Agendado SO agora, depois da resposta: nunca ha dois ciclos em
      // voo, e uma falha nao acelera a proxima tentativa.
      if (vivo) agendamento = window.setTimeout(() => void ciclo(), INTERVALO_REFRESH_MS);
    };

    void ciclo();

    return () => {
      vivo = false;
      if (agendamento !== null) window.clearTimeout(agendamento);
      controlador.abort();
    };
  }, []);

  // ── O DESPERTADOR VISUAL ──────────────────────────────────────────
  //
  // Um so, one-shot, sem rede. Ele nao busca nada: apenas empurra o
  // relogio local para a fronteira, o que faz `aparenciaDoAgente`
  // recalcular e o flash apagar no instante certo.
  //
  // Reagendado sempre que o retrato ou o relogio mudam, e o `cleanup`
  // cancela o anterior — entao nunca ha dois despertadores vivos, e um
  // snapshot novo invalida o antigo. Quando ele dispara, `agoraMs`
  // passa da fronteira que o motivou, aquele sinal deixa de contar e o
  // proximo (se houver) e agendado. Sem flash vivo, `proximaExpiracaoMs`
  // devolve `null` e nenhum timer nasce — e o ciclo termina sozinho.
  useEffect(() => {
    if (agoraMs === null) return;
    const expira = proximaExpiracaoMs(agentes, agoraMs);
    if (expira === null) return;
    const despertador = window.setTimeout(() => setAgoraMs(Date.now()), expira - agoraMs);
    return () => window.clearTimeout(despertador);
  }, [agentes, agoraMs]);

  // ── A ORDEM DE APRESENTACAO ───────────────────────────────────────
  //
  // O servidor ordena por `criado_em`, sem desempate. Aqui a ordem e
  // fechada com `id` — so para apresentacao, nada e persistido. E essa
  // ordem que ocupa os `OFFICE_SLOTS`: o primeiro agente vai para a
  // mesa 1, e assim por diante. Nenhuma mesa pertence a um nome.
  const ordenados = useMemo(
    () =>
      [...agentes].sort((a, b) => {
        const porData = a.agente.criado_em.localeCompare(b.agente.criado_em);
        if (porData !== 0) return porData;
        return a.agente.id < b.agente.id ? -1 : a.agente.id > b.agente.id ? 1 : 0;
      }),
    [agentes]
  );

  // ── A SELECAO ─────────────────────────────────────────────────────
  //
  // Identidade e `agente.id`, nunca o nome. Sem selecao (primeira leitura)
  // ou com o selecionado sumido apos um refresh, vale o primeiro agente
  // visualizado. Lista vazia: nada selecionado.
  //
  // F8.3-C1.1: a primeira selecao so acontece com a lista REAL na mao
  // (`estado === "ok"`), entao o `?agente=` e aplicado antes de qualquer
  // outro agente ser escolhido — sem trocar de A para B na tela.
  useEffect(() => {
    if (estado !== "ok") return;
    if (selecionado !== null && ordenados.some((a) => a.agente.id === selecionado)) return;
    const proximo = escolherSelecao(ordenados.map((a) => a.agente.id), selecionado, pedido.current);
    pedido.current = null;
    setSelecionado(proximo);
  }, [estado, ordenados, selecionado]);

  const comAparencia = useMemo(() => {
    if (agoraMs === null) return [];
    return ordenados.map((item) => ({
      agente: item.agente,
      // Os cinco estados e o flash transitorio continuam sendo derivados
      // AQUI, pelo helper de sempre. O servidor nao manda estado pronto:
      // manda os sinais de que ele e feito.
      aparencia: aparenciaDoAgente(item.agente, item.sinais, agoraMs),
      atividade: item.atividade,
    }));
  }, [ordenados, agoraMs]);

  const naCena = comAparencia.slice(0, OFFICE_SLOTS.length);
  const outros = comAparencia.slice(OFFICE_SLOTS.length);
  const aberto = comAparencia.find((a) => a.agente.id === selecionado) ?? null;

  const aviso =
    estado === "carregando" ? (
      "Montando o escritório…"
    ) : estado === "nao_autenticado" ? (
      "Sua sessão expirou. Entre novamente para ver o escritório."
    ) : estado === "falha" ? (
      // Falha na PRIMEIRA leitura. A tela assume que nao conseguiu
      // perguntar — nunca finge um escritorio vazio, e nunca cai para
      // dados simulados.
      "Não foi possível carregar o escritório agora. A tela tenta de novo sozinha."
    ) : comAparencia.length === 0 ? (
      <>
        Você ainda não tem agentes. Crie o primeiro na{" "}
        <a href="/ia/agentes">lista de agentes</a>.
      </>
    ) : null;

  return (
    // Grade de areas: cena e painel lado a lado, "Outros agentes" sob a
    // cena, e o chat na largura inteira (cena + painel) logo abaixo.
    <div
      className={outros.length > 0 ? estilos.raiz : `${estilos.raiz} ${estilos.raizSemOutros}`}
    >
      <div className={estilos.areaCena}>
        <OfficeSceneV1
          naCena={naCena}
          selecionado={selecionado}
          onSelecionar={setSelecionado}
          aviso={aviso}
        />
      </div>

      {outros.length > 0 && (
        <div className={estilos.areaOutros}>
          <OutrosAgentes agentes={outros} selecionado={selecionado} onSelecionar={setSelecionado} />
        </div>
      )}

      <div className={`${estilos.areaPainel} ${estilos.colunaDireita}`}>
        {aberto && (
          <OfficeAgentPanelV1
            key={aberto.agente.id}
            agente={aberto.agente}
            aparencia={aberto.aparencia}
            atividade={aberto.atividade}
          />
        )}
        {/* F8.2-A: GLOBAL do Escritorio — fora do `key` do agente, entao
            trocar de agente nao refaz a leitura de vendas. */}
        <VendasAoVivo />
      </div>

      {/* `key` por agente: trocar de agente desmonta o host inteiro, e
          nenhuma conversa do agente anterior sobrevive a troca. */}
      {aberto && (
        <div className={estilos.areaChat}>
          <OfficeChatHost
            key={aberto.agente.id}
            agenteId={aberto.agente.id}
            nome={aberto.agente.nome}
            ativo={aberto.agente.ativo}
          />
        </div>
      )}
    </div>
  );
}
