"use client";

/**
 * A BUSCA de ferramentas — AGENT-FACTORY-F7b.4.1.
 *
 * ── O problema que ela resolve ──────────────────────────────────────
 *
 * A etapa Ferramentas mostrava cinco cartoes fixos. Isso funciona
 * enquanto existem cinco; nao funciona com 1584 integracoes atras.
 *
 * Aqui a pessoa digita o que quer fazer — "planilha", "sheets",
 * "calendario" — e as duas origens respondem juntas. Ela nao precisa
 * saber que uma delas e Function da casa e a outra vem de um catalogo
 * externo; precisa saber se exige conectar conta e se escreve.
 *
 * ── O catalogo externo NAO e baixado ────────────────────────────────
 *
 * Sem termo, so as internas aparecem. A busca externa acontece quando ha
 * termo, paginada no servidor, com limite. Os 1584 toolkits nunca estao
 * em memoria aqui, e e isso que impede que um dia alguem os despeje num
 * prompt.
 *
 * ── Escolher UMA acao, e nao um aplicativo inteiro ──────────────────
 *
 * Google Sheets tem 36 acoes. Vincular todas de uma vez daria ao agente
 * 36 ferramentas que ninguem revisou. Clicar no aplicativo abre as acoes;
 * cada uma e vinculada por vez, e cada uma vira uma Function CDS com
 * permissao propria.
 *
 * ── Escrita nunca nasce automatica ──────────────────────────────────
 *
 * O nivel NAO e escolhido aqui. Quem o decide e o servidor, pelo risco da
 * acao: leitura nasce `automatico`, escrita e desconhecido nascem em
 * `aprovacao`. A tela mostra o que foi decidido.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";
import {
  Aviso, Botao, Campo, Cartao, Etiqueta, PainelLateral, TAMANHO,
} from "@/components/ui/Primitivas";
import {
  buscarFerramentasDisponiveis, definirPermissaoDeFerramentaExterna,
  desvincularFerramentaExterna,
  iniciarConexaoExterna, listarAcoesDoAplicativo, listarConexoesExternas,
  listarFerramentasExternas, vincularFerramentaExterna,
  type AcaoExternaUI, type AchadoDeFerramentaUI, type ContaExternaUI,
  type FerramentaExternaVinculadaUI, type RespostaDaFactory,
} from "@/lib/ia/agentes-http";

/**
 * O que cada estado de conta significa para quem esta olhando — F7b.4.2.
 *
 * A frase fala do que a PESSOA precisa fazer, e nao do que o provedor
 * respondeu. `INITIALIZING` nao diz nada a ninguem; "falta você autorizar"
 * diz.
 */
const FRASE_DA_CONTA: Readonly<Record<string, string>> = Object.freeze({
  conectada: "Conta conectada.",
  aguardando_dono: "Falta você autorizar no aplicativo.",
  com_problema: "A conexão parou de funcionar. Conecte de novo.",
  desconhecida: "Não foi possível saber o estado desta conexão.",
});

/** Espera antes de buscar, para nao chamar a cada tecla. */
const ESPERA_MS = 350;

function frasePorEstado(r: RespostaDaFactory<unknown>, padrao: string): string {
  if (r.estado === "nao_autenticado") return "Sua sessão expirou. Entre novamente.";
  if (r.estado === "nao_encontrado") return "Isto não foi encontrado.";
  if (r.estado === "recusado") return r.mensagem;
  return padrao;
}

const ROTULO_DO_RISCO: Record<string, string> = {
  leitura: "Leitura",
  escrita: "Escrita",
  desconhecido: "Não classificada",
};

const ROTULO_DO_NIVEL: Record<string, string> = {
  automatico: "Automático",
  aprovacao: "Pede aprovação",
  bloqueado: "Bloqueada",
};

export function BuscaDeFerramentas({
  agenteId, aoMudar, packSelecionado, aoAdicionarPack,
}: {
  agenteId: string;
  /** Avisa o wizard para recarregar o resumo. */
  aoMudar?: () => void;
  /** `true` quando o pack interno daquela chave ja esta no agente. */
  packSelecionado: (chave: string) => boolean;
  /** Adiciona um pack INTERNO — o wizard ja sabe fazer isso. */
  aoAdicionarPack: (chave: string) => void;
}) {
  const [termo, setTermo] = useState("");
  const [achados, setAchados] = useState<readonly AchadoDeFerramentaUI[]>([]);
  const [externoDesfecho, setExternoDesfecho] = useState<string>("nao_consultado");
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [vinculadas, setVinculadas] = useState<readonly FerramentaExternaVinculadaUI[]>([]);

  // O painel de ações de um aplicativo externo.
  const [aplicativo, setAplicativo] = useState<string | null>(null);
  const [acoes, setAcoes] = useState<readonly AcaoExternaUI[]>([]);
  const [totalDeAcoes, setTotalDeAcoes] = useState(0);
  const [carregandoAcoes, setCarregandoAcoes] = useState(false);

  // F7b.4.2 §14: as contas do DONO. Nao pertencem ao agente, e por isso
  // nao entram no estado de ativacao dele.
  const [contas, setContas] = useState<readonly ContaExternaUI[]>([]);
  const [conectando, setConectando] = useState(false);

  /**
   * A acao cujo nivel a pessoa esta escolhendo AGORA — F7b.4.4 §3.
   *
   * Adicionar deixou de ser um clique so. O gate pediu isso depois de o
   * Rodrigo ser surpreendido no chat: ele adicionou ferramentas, foi
   * conversar, e so ali descobriu que faltava decidir a permissao.
   *
   * A separacao do backend NAO muda — vincular e permitir continuam sendo
   * duas escritas, em duas tabelas, com dois significados. O que mudou e
   * que a UX coleta as duas no mesmo lugar, para nao empurrar a surpresa
   * para o chat.
   */
  const [escolhendoNivel, setEscolhendoNivel] = useState<string | null>(null);
  const [salvandoNivel, setSalvandoNivel] = useState(false);

  const relogio = useRef<ReturnType<typeof setTimeout> | null>(null);

  const recarregarVinculadas = useCallback(async () => {
    const r = await listarFerramentasExternas(agenteId);
    if (r.estado === "ok") setVinculadas(r.dados);
  }, [agenteId]);

  useEffect(() => { void recarregarVinculadas(); }, [recarregarVinculadas]);

  // Busca com espera: digitar "sheets" nao deve virar seis chamadas.
  useEffect(() => {
    if (relogio.current !== null) clearTimeout(relogio.current);
    relogio.current = setTimeout(() => {
      void (async () => {
        setBuscando(true);
        setErro(null);
        const r = await buscarFerramentasDisponiveis(termo);
        setBuscando(false);
        if (r.estado !== "ok") {
          setErro(frasePorEstado(r, "Não foi possível buscar."));
          return;
        }
        setAchados(r.dados.achados);
        setExternoDesfecho(r.dados.externoDesfecho);
      })();
    }, ESPERA_MS);
    return () => { if (relogio.current !== null) clearTimeout(relogio.current); };
  }, [termo]);

  /**
   * Pede o link e leva a pessoa ate o provedor.
   *
   * Aba NOVA, de proposito: a configuracao do agente fica aberta atras, e
   * ao voltar a pessoa nao perde onde estava. `noopener` porque a pagina de
   * destino nao tem nada que fazer com esta janela.
   *
   * Nenhum token viaja: o servidor devolve a URL ja pronta.
   */
  async function conectarConta(toolkit: string) {
    setErro(null);
    setConectando(true);
    try {
      const r = await iniciarConexaoExterna(toolkit);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível iniciar a conexão."));
        return;
      }
      window.open(r.dados.urlParaConectar, "_blank", "noopener,noreferrer");
      // Recarrega o estado: ao voltar, a pessoa ve `conectada` sem
      // precisar recarregar a pagina inteira.
      const c = await listarConexoesExternas(toolkit);
      if (c.estado === "ok") setContas(c.dados);
    } finally {
      setConectando(false);
    }
  }

  async function abrirAplicativo(chave: string) {
    setErro(null);
    setAplicativo(chave);
    setAcoes([]);
    setContas([]);
    setCarregandoAcoes(true);
    // A conta e consultada junto das acoes: sem ela, a pessoa escolheria
    // ferramentas sem saber que ainda falta autorizar o aplicativo.
    void listarConexoesExternas(chave).then((c) => {
      if (c.estado === "ok") setContas(c.dados);
    });
    try {
      const r = await listarAcoesDoAplicativo(agenteId, chave);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível listar as ações deste aplicativo."));
        return;
      }
      setAcoes(r.dados.acoes);
      setTotalDeAcoes(r.dados.totalDisponivel);
    } finally {
      setCarregandoAcoes(false);
    }
  }

  /**
   * Adiciona a acao COM a permissao que a pessoa escolheu.
   *
   * Duas chamadas, e duas de proposito: `POST` grava o VINCULO (o agente
   * passa a ter a acao) e `PATCH` grava a PERMISSAO (como ele pode usa-la).
   * Sao tabelas diferentes com significados diferentes, e juntar as duas
   * num endpoint so recriaria exatamente o defeito que o F7b.4.2 corrigiu.
   *
   * Se a segunda falhar, a acao fica vinculada e SEM permissao — que e um
   * estado legitimo e visivel: a etapa Permissoes mostra "falta definir", e
   * a ativacao barra. A degradacao e para um estado honesto, nunca para um
   * default nosso.
   */
  async function vincular(acao: string, nivel: string) {
    if (aplicativo === null) return;
    setErro(null);
    setSalvandoNivel(true);
    try {
      const r = await vincularFerramentaExterna(agenteId, aplicativo, acao);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível adicionar esta ação."));
        return;
      }
      const p = await definirPermissaoDeFerramentaExterna(agenteId, r.dados.funcaoId, nivel);
      if (p.estado !== "ok") {
        setErro(frasePorEstado(p,
          "A ação foi adicionada, mas a permissão não pôde ser salva. " +
          "Defina na etapa Permissões."));
      }
      setEscolhendoNivel(null);
      await recarregarVinculadas();
      aoMudar?.();
    } finally {
      setSalvandoNivel(false);
    }
  }

  async function desvincular(funcaoId: string) {
    setErro(null);
    const r = await desvincularFerramentaExterna(agenteId, funcaoId);
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível remover esta ação."));
      return;
    }
    await recarregarVinculadas();
    aoMudar?.();
  }

  const jaVinculada = (toolkit: string, acao: string): boolean =>
    vinculadas.some((v) => v.toolkit === toolkit && v.acao === acao.toLowerCase() &&
      v.nivel !== "bloqueado");

  return (
    <>
      <Campo
        rotulo="Pesquisar ferramenta ou aplicativo"
        valor={termo}
        aoMudar={setTermo}
        placeholder="Ex.: planilha, sheets, calendário, gmail"
        ajuda="Busca no que a CDS faz e nos aplicativos que dá para conectar."
        maxLength={80}
      />

      {erro !== null && <Aviso tom="erro">{erro}</Aviso>}

      {termo.trim() !== "" && externoDesfecho === "nao_configurado" && (
        <Aviso tom="info">
          As ferramentas da CDS aparecem abaixo. A busca por aplicativos externos não está
          configurada neste ambiente.
        </Aviso>
      )}
      {termo.trim() !== "" && externoDesfecho === "falha" && (
        <Aviso tom="atencao">
          As ferramentas da CDS aparecem abaixo. A busca por aplicativos externos falhou agora —
          tente de novo em instantes.
        </Aviso>
      )}

      {buscando && (
        <p style={{ margin: 0, fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
          Procurando…
        </p>
      )}

      {!buscando && achados.length === 0 && termo.trim() !== "" && (
        <p style={{ margin: 0, fontSize: TAMANHO.corpo, color: CROMO.textoFraco }}>
          Nada encontrado para <strong>{termo}</strong>. Tente outra palavra.
        </p>
      )}

      {achados.map((a) => {
        const interna = a.origem === "cds";
        const dentro = interna && packSelecionado(a.chave);
        return (
          <Cartao key={`${a.origem}:${a.chave}`} destacado={dentro}>
            <div style={{
              display: "flex", justifyContent: "space-between",
              gap: ESPACO.md, flexWrap: "wrap", alignItems: "flex-start",
            }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                  {a.nome}
                </strong>
                <p style={{
                  margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
                  fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                }}>
                  {a.descricao}
                </p>
                <div style={{ display: "flex", gap: ESPACO.xs, flexWrap: "wrap" }}>
                  {/* A ORIGEM em palavra, não em id técnico. */}
                  <Etiqueta>{interna ? "Da CDS" : "Integração"}</Etiqueta>
                  {a.acesso === "leitura" && <Etiqueta tom="ok">Leitura</Etiqueta>}
                  {a.acesso === "escrita" && <Etiqueta tom="atencao">Escrita</Etiqueta>}
                  {a.exigeConexao && <Etiqueta tom="info">Conexão necessária</Etiqueta>}
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
                {interna ? (
                  dentro
                    ? <Etiqueta tom="ok">Adicionada</Etiqueta>
                    : <Botao tom="primario" onClick={() => aoAdicionarPack(a.chave)}>
                        Adicionar
                      </Botao>
                ) : (
                  <Botao tom="secundario" onClick={() => void abrirAplicativo(a.chave)}>
                    Ver ações
                  </Botao>
                )}
              </div>
            </div>
          </Cartao>
        );
      })}

      {/* ── As ações externas já vinculadas ── */}
      {vinculadas.filter((v) => v.nivel !== "bloqueado").length > 0 && (
        <div>
          <h2 style={{
            fontSize: TAMANHO.corpo, color: CROMO.texto, margin: `${ESPACO.md}px 0 ${ESPACO.sm}px`,
          }}>
            Ações de aplicativos neste agente
          </h2>
          {vinculadas.filter((v) => v.nivel !== "bloqueado").map((v) => (
            <Cartao key={v.funcaoId} destacado>
              <div style={{
                display: "flex", justifyContent: "space-between",
                gap: ESPACO.md, flexWrap: "wrap", alignItems: "flex-start",
              }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                    {v.toolkit}
                  </strong>
                  <p style={{
                    margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
                    fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                  }}>
                    {v.acao.replace(/_/g, " ")}
                  </p>
                  <div style={{ display: "flex", gap: ESPACO.xs, flexWrap: "wrap" }}>
                    <Etiqueta tom={v.risco === "leitura" ? "ok" : "atencao"}>
                      {ROTULO_DO_RISCO[v.risco] ?? v.risco}
                    </Etiqueta>
                    {/*
                      F7b.4.2 §11: `nivel: null` e VINCULADA E SEM DECISAO.
                      A etiqueta diz isso em vez de mostrar a sugestao como
                      se fosse escolha — era exatamente o que o desenho
                      anterior fazia, e o que o gate corrigiu.
                    */}
                    {v.nivel === null
                      ? <Etiqueta tom="atencao">Falta definir a permissão</Etiqueta>
                      : <Etiqueta tom={v.nivel === "automatico" ? "ok" : "info"}>
                          {ROTULO_DO_NIVEL[v.nivel] ?? v.nivel}
                        </Etiqueta>}
                  </div>
                  <details style={{ marginTop: ESPACO.sm }}>
                    <summary style={{
                      cursor: "pointer", fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                    }}>
                      Detalhes técnicos
                    </summary>
                    <code style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                      {v.funcaoId}
                    </code>
                  </details>
                </div>
                <Botao tom="perigo" onClick={() => void desvincular(v.funcaoId)}>
                  Remover
                </Botao>
              </div>
            </Cartao>
          ))}
        </div>
      )}

      {/* ── O painel de ações de um aplicativo ── */}
      <PainelLateral
        aberto={aplicativo !== null}
        titulo={aplicativo === null ? "Ações" : `Ações de ${aplicativo}`}
        aoFechar={() => setAplicativo(null)}
      >
        {carregandoAcoes && (
          <p style={{ fontSize: TAMANHO.corpo, color: CROMO.textoFraco, margin: 0 }}>
            Carregando ações…
          </p>
        )}

        {/*
          F7b.4.2 §14: a conta vem ANTES da lista de acoes, porque sem ela
          nenhuma acao executaria. E conectar NAO concede nada ao agente —
          o que permite continua sendo a permissao, na etapa seguinte.
        */}
        {aplicativo !== null && !carregandoAcoes && (
          <Cartao>
            {(() => {
              const conta = contas.find((c) => c.toolkit === aplicativo);
              const conectada = conta?.estado === "conectada";
              return (
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  gap: ESPACO.md, flexWrap: "wrap", alignItems: "center",
                }}>
                  <div style={{ minWidth: 0 }}>
                    <Etiqueta tom={conectada ? "ok" : "atencao"}>
                      {conta === undefined
                        ? "Conta não conectada"
                        : FRASE_DA_CONTA[conta.estado] ?? "Estado desconhecido"}
                    </Etiqueta>
                    <p style={{
                      margin: `${ESPACO.xs}px 0 0`,
                      fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                    }}>
                      Conectar a conta não dá permissão a este agente. Você decide o que
                      ele pode fazer na etapa Permissões.
                    </p>
                  </div>
                  <Botao tom={conectada ? "secundario" : "primario"} desabilitado={conectando}
                    onClick={() => void conectarConta(aplicativo)}>
                    {conectando ? "Abrindo…" : conectada ? "Conectar outra" : "Conectar conta"}
                  </Botao>
                </div>
              );
            })()}
          </Cartao>
        )}

        {!carregandoAcoes && acoes.length > 0 && (
          <p style={{ margin: 0, fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
            Escolha só o que este agente precisa. Mostrando {acoes.length} de {totalDeAcoes}.
            Adicionar não dá permissão — você decide o nível na etapa Permissões.
          </p>
        )}

        {acoes.map((a) => {
          const dentro = aplicativo !== null && jaVinculada(aplicativo, a.acao);
          return (
            <div key={a.acao} style={{
              padding: `${ESPACO.sm}px 0`,
              borderBottom: `1px solid ${CROMO.bordaSutil}`,
            }}>
              <div style={{
                display: "flex", justifyContent: "space-between",
                gap: ESPACO.sm, alignItems: "flex-start",
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>{a.nome}</div>
                  {a.descricao !== null && (
                    <p style={{
                      margin: `2px 0 ${ESPACO.xs}px`,
                      fontSize: TAMANHO.miudo, color: CROMO.textoFraco, lineHeight: 1.45,
                    }}>
                      {a.descricao.slice(0, 160)}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: ESPACO.xs, flexWrap: "wrap" }}>
                    <Etiqueta tom={a.risco === "leitura" ? "ok" : "atencao"}>
                      {ROTULO_DO_RISCO[a.risco] ?? a.risco}
                    </Etiqueta>
                    {/* SUGESTAO, e o texto diz isso. Adicionar nao concede. */}
                    <Etiqueta tom="info">
                      Sugerido: {ROTULO_DO_NIVEL[a.nivelSugerido] ?? a.nivelSugerido}
                    </Etiqueta>
                  </div>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {dentro
                    ? <Etiqueta tom="ok">Adicionada</Etiqueta>
                    : a.funcaoId === null
                      ? <Etiqueta tom="atencao">Indisponível</Etiqueta>
                      : escolhendoNivel === a.acao
                        ? null
                        : <Botao tom="primario"
                            onClick={() => setEscolhendoNivel(a.acao)}>
                            Adicionar
                          </Botao>}
                </div>
              </div>

              {/*
                §3/§13: adicionar PERGUNTA o nivel. A sugestao aparece
                marcada como sugestao — e nao pre-selecionada —, porque
                sugestao nao e decisao. Quem confirma e a pessoa.
              */}
              {escolhendoNivel === a.acao && a.funcaoId !== null && (
                <div style={{
                  marginTop: ESPACO.sm, paddingTop: ESPACO.sm,
                  borderTop: `1px solid ${CROMO.borda}`,
                }}>
                  <p style={{
                    margin: `0 0 ${ESPACO.xs}px`,
                    fontSize: TAMANHO.miudo, color: CROMO.texto,
                  }}>
                    Quando o agente pode usar esta ação?
                  </p>
                  <div style={{ display: "flex", gap: ESPACO.xs, flexWrap: "wrap" }}>
                    {(["automatico", "aprovacao", "bloqueado"] as const).map((n) => (
                      <Botao key={n}
                        tom={n === a.nivelSugerido ? "primario" : "secundario"}
                        desabilitado={salvandoNivel}
                        onClick={() => void vincular(a.acao, n)}>
                        {ROTULO_DO_NIVEL[n] ?? n}
                        {n === a.nivelSugerido ? " (sugerido)" : ""}
                      </Botao>
                    ))}
                    <Botao tom="secundario" desabilitado={salvandoNivel}
                      onClick={() => setEscolhendoNivel(null)}>
                      Cancelar
                    </Botao>
                  </div>
                  <p style={{
                    margin: `${ESPACO.xs}px 0 0`,
                    fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                  }}>
                    {a.risco === "leitura"
                      ? "Esta ação só lê dados."
                      : "Esta ação altera dados no aplicativo."}
                    {" "}Você pode mudar depois, na etapa Permissões.
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {!carregandoAcoes && acoes.length === 0 && (
          <p style={{ fontSize: TAMANHO.corpo, color: CROMO.textoFraco, margin: 0 }}>
            Nenhuma ação disponível.
          </p>
        )}
      </PainelLateral>
    </>
  );
}
