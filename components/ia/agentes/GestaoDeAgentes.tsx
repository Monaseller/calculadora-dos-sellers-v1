"use client";

/**
 * Pagina Agentes — layout final (v0 aprovado). F8.3-C1 / C1.4.
 *
 *   [ Seus agentes ][ Selecionar agente para modificar ]
 *   [   (lista)    ][ Chat do agente (REAL)            ]
 *   [   (lista)    ][ Configuracao (REAL)              ]
 *
 * ── UMA selecao ─────────────────────────────────────────────────────
 *
 * `selecionado` (o id) e a UNICA fonte: o card da esquerda, o item do
 * seletor, o chat e a configuracao leem dela, e qualquer um dos dois
 * pontos de selecao (card ou seletor) escreve nela. Nao ha estado de
 * selecao em nenhum filho.
 *
 * Inicial: `?agente=<id>` se ele existir na lista real; senao o primeiro.
 * Selecionar grava `?agente=` na URL (link direto + voltar do navegador).
 *
 * ── Dados ───────────────────────────────────────────────────────────
 *
 *   agentes + sinais  `listarAgentesDoEscritorio` (a leitura do Escritorio);
 *                     estado por `aparenciaDoAgente`, a regra canonica.
 *   IA/APIs/Tools/    `lerAtivacaoDoAgente` por agente, em paralelo.
 *   memoria           Uma falha fica no card daquele agente.
 *
 * Chat e configuracao remontam por agente (`key`): nada do anterior vaza.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { aparenciaDoAgente } from "@/lib/ia/estados";
import {
  lerAtivacaoDoAgente, listarAgentesDoEscritorio,
  type AgenteComSnapshotUI, type AtivacaoDoAgenteUI,
} from "@/lib/ia/agentes-http";
import {
  CHAVES_DE_FILTRO_DA_LISTA, ROTULO_DO_FILTRO, passaNaBusca, passaNoFiltro, podeTrocarDeAgente,
  projetarCapacidades, type FiltroAgentes,
} from "@/lib/ia/agentes-gestao";
import CartaoDeAgente from "@/components/ia/agentes/CartaoDeAgente";
import SeletorDeAgentes from "@/components/ia/agentes/SeletorDeAgentes";
import ChatNaGestao from "@/components/ia/agentes/ChatNaGestao";
import ConfiguracaoDoAgente from "@/components/ia/agentes/ConfiguracaoDoAgente";
import estilos from "@/components/ia/agentes/agentes.module.css";
import { IconeBusca } from "@/components/ia/agentes/icones";

type Leitura = "carregando" | "ok" | "nao_autenticado" | "falha";
type EstadoDaAtivacao = AtivacaoDoAgenteUI | "falha";

/** Mesma ordem de apresentacao do Escritorio: criado_em, id. */
function ordenar(lista: readonly AgenteComSnapshotUI[]): AgenteComSnapshotUI[] {
  return [...lista].sort((a, b) => {
    const d = a.agente.criado_em.localeCompare(b.agente.criado_em);
    if (d !== 0) return d;
    return a.agente.id < b.agente.id ? -1 : a.agente.id > b.agente.id ? 1 : 0;
  });
}

function lerSelecaoDaUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("agente");
}

function gravarSelecaoNaUrl(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("agente", id);
  window.history.pushState(null, "", url.toString());
}

const AVISO_RASCUNHO =
  "Há alterações não salvas na configuração deste agente. Trocar de agente e descartá-las?";

/** A selecao valida: a pedida, se existe; senao a atual; senao a primeira. */
export function resolverSelecao(
  ids: readonly string[], atual: string | null, pedida: string | null
): string | null {
  if (pedida !== null && ids.includes(pedida)) return pedida;
  if (atual !== null && ids.includes(atual)) return atual;
  return ids[0] ?? null;
}

export default function GestaoDeAgentes() {
  const [leitura, setLeitura] = useState<Leitura>("carregando");
  const [agentes, setAgentes] = useState<readonly AgenteComSnapshotUI[]>([]);
  const [ativacoes, setAtivacoes] = useState<ReadonlyMap<string, EstadoDaAtivacao>>(new Map());
  const [agoraMs, setAgoraMs] = useState<number | null>(null);
  const [termo, setTermo] = useState("");
  const [filtro, setFiltro] = useState<FiltroAgentes>("todos");
  // ── A selecao UNICA ──
  const [selecionado, setSelecionado] = useState<string | null>(null);

  /** Um controlador por leitura: sair da pagina (ou reler) cancela a anterior. */
  const controladorRef = useRef<AbortController | null>(null);

  /**
   * Rascunho nao salvo na configuracao aberta (F8.3-C1.5). Ref, e nao
   * estado: so e consultado no momento da troca, sem re-render.
   */
  const rascunhoRef = useRef(false);
  const aoAlterarRascunho = useCallback((tem: boolean) => { rascunhoRef.current = tem; }, []);
  const confirmarDescarte = () => podeTrocarDeAgente(rascunhoRef.current, () => window.confirm(AVISO_RASCUNHO));
  /** O selecionado atual para o `popstate` (o handler e registrado uma vez). */
  const selecionadoRef = useRef<string | null>(null);
  selecionadoRef.current = selecionado;

  const carregar = useCallback(async () => {
    controladorRef.current?.abort();
    const controlador = new AbortController();
    controladorRef.current = controlador;
    const r = await listarAgentesDoEscritorio(controlador.signal);
    if (controlador.signal.aborted) return;
    if (r.estado !== "ok") {
      setLeitura((anterior) => (anterior === "ok" ? "ok" : r.estado));
      return;
    }
    const ordenados = ordenar(r.agentes);
    setAgentes(ordenados);
    setAgoraMs(Date.now());
    setLeitura("ok");
    // Selecao inicial (ou reparo, se o selecionado sumiu): ?agente= ou o primeiro.
    setSelecionado((atual) => resolverSelecao(
      ordenados.map((a) => a.agente.id), atual, atual === null ? lerSelecaoDaUrl() : null));
    const pares = await Promise.all(r.agentes.map(async ({ agente }) => {
      const a = await lerAtivacaoDoAgente(agente.id, controlador.signal);
      return [agente.id, a.estado === "ok" ? a.dados : "falha"] as const;
    }));
    if (controlador.signal.aborted) return;
    setAtivacoes(new Map(pares));
  }, []);

  useEffect(() => {
    void carregar();
    const aoVoltar = () => {
      const pedido = lerSelecaoDaUrl();
      if (pedido === null || pedido === selecionadoRef.current) return;
      if (!podeTrocarDeAgente(rascunhoRef.current, () => window.confirm(AVISO_RASCUNHO))) {
        // Fica no agente atual: a URL volta a apontar para ele.
        if (selecionadoRef.current !== null) gravarSelecaoNaUrl(selecionadoRef.current);
        return;
      }
      setSelecionado(pedido);
    };
    window.addEventListener("popstate", aoVoltar);
    return () => {
      window.removeEventListener("popstate", aoVoltar);
      // Sair da pagina cancela as leituras em voo.
      controladorRef.current?.abort();
    };
  }, [carregar]);

  const selecionar = (id: string) => {
    if (id === selecionado) return;
    if (!confirmarDescarte()) return;
    setSelecionado(id);
    gravarSelecaoNaUrl(id);
  };

  const comAparencia = useMemo(() => {
    if (agoraMs === null) return [];
    return agentes.map((item) => {
      const a = ativacoes.get(item.agente.id);
      const ativ = a === undefined || a === "falha" ? null : a;
      return {
        agente: item.agente,
        aparencia: aparenciaDoAgente(item.agente, item.sinais, agoraMs),
        ativacao: ativ,
        ativacaoFalhou: a === "falha",
        usaMercadoLivre: ativ !== null && projetarCapacidades(ativ).packsDeApi.length > 0,
      };
    });
  }, [agentes, agoraMs, ativacoes]);

  const visiveis = comAparencia.filter((a) =>
    passaNoFiltro(filtro, a.aparencia) && passaNaBusca(termo, a.agente.nome, a.agente.tipo));
  const aberto = comAparencia.find((a) => a.agente.id === selecionado) ?? null;
  const contagem = (f: FiltroAgentes) => comAparencia.filter((a) => passaNoFiltro(f, a.aparencia)).length;

  if (leitura !== "ok") {
    return (
      <div className={estilos.raiz}>
        <p className={estilos.vazio} role={leitura === "carregando" ? "status" : "alert"}>
          {leitura === "carregando" ? "Carregando agentes…"
            : leitura === "nao_autenticado" ? "Sua sessão expirou. Entre novamente."
            : "Não foi possível carregar os agentes agora."}
        </p>
      </div>
    );
  }

  if (comAparencia.length === 0) {
    return (
      <div className={estilos.raiz}>
        <p className={estilos.vazio}>
          Você ainda não tem agentes. Crie o primeiro pela navegação no topo da área.
        </p>
      </div>
    );
  }

  return (
    <div className={`${estilos.raiz} ${estilos.operacional}`}>
      {/* ── A. Coluna esquerda: Seus agentes ── */}
      <section aria-labelledby="ag-lista-titulo" className={estilos.colunaLista}>
        <header className={estilos.listaTopo}>
          <h2 id="ag-lista-titulo" className={estilos.secaoTitulo}>
            Seus agentes <span className={estilos.fraco}>({comAparencia.length})</span>
          </h2>
          <div className={estilos.busca}>
            <span className={estilos.buscaIcone}><IconeBusca tamanho={15} /></span>
            <input
              type="search" value={termo} onChange={(e) => setTermo(e.target.value)}
              placeholder="Buscar agentes..." aria-label="Buscar agentes"
            />
          </div>
          <div role="tablist" aria-label="Filtrar agentes" className={estilos.filtros}>
            {CHAVES_DE_FILTRO_DA_LISTA.map((f) => (
              <button
                key={f} type="button" role="tab" aria-selected={f === filtro}
                onClick={() => setFiltro(f)}
                className={`${estilos.filtro} ${f === filtro ? estilos.filtroAtivo : ""}`}
              >
                {ROTULO_DO_FILTRO[f]}
                <span className={estilos.filtroContagem}>{contagem(f)}</span>
              </button>
            ))}
          </div>
        </header>
        {visiveis.length === 0 ? (
          <p className={estilos.listaVazia}>Nenhum agente encontrado.</p>
        ) : (
          <ul className={estilos.listaAgentes}>
            {visiveis.map((v) => (
              <li key={v.agente.id}>
                <CartaoDeAgente
                  agente={v.agente}
                  aparencia={v.aparencia}
                  ativacao={v.ativacao}
                  ativacaoFalhou={v.ativacaoFalhou}
                  selecionado={v.agente.id === selecionado}
                  aoConfigurar={() => selecionar(v.agente.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── B/C/D. Direita: seletor, chat real, configuracao real ── */}
      <div className={estilos.colunaTrabalho}>
        <SeletorDeAgentes
          itens={comAparencia}
          selecionado={selecionado}
          aoSelecionar={selecionar}
        />
        {aberto && (
          <>
            {/* `key` por agente: a conversa do anterior nao vaza. */}
            <ChatNaGestao
              key={`chat:${aberto.agente.id}`}
              agenteId={aberto.agente.id}
              nome={aberto.agente.nome}
              ativo={aberto.agente.ativo}
              aparencia={aberto.aparencia}
            />
            <ConfiguracaoDoAgente
              key={`cfg:${aberto.agente.id}`}
              agente={aberto.agente}
              aparencia={aberto.aparencia}
              aoMudar={() => void carregar()}
              aoAlterarRascunho={aoAlterarRascunho}
            />
          </>
        )}
      </div>
    </div>
  );
}
