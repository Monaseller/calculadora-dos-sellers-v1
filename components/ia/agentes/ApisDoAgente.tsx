"use client";

/**
 * Aba APIs da configuracao inline — F8.3-C1.6.
 *
 * APIs = INTEGRACOES DA CDS (Mercado Livre, Shopee), nao uma busca solta
 * de aplicativos. Cada integracao mostra duas coisas, das fontes reais:
 *
 *   conta na CDS   as contas do dono por provider, de `buscarApisDoAgente`
 *                  (GET /apis). Sem conta: "Conectar" abre o fluxo
 *                  OAuth da CDS numa aba nova — a pagina nao se perde.
 *   neste agente   o pack de agente da integracao (`adicionarPackAoAgente`
 *                  / `removerPackDoAgente`, nivel) e UMA conta por provider
 *                  (`buscarApisDoAgente` / `definirContaDaApi`, F9.2-A2).
 *
 * "Conectar" com conta ja disponivel e AUTOMATICO quando so ha uma conta
 * possivel (`planoDaApi`): um PATCH do provider e UMA releitura. Com mais
 * de uma conta, o dono escolhe UMA — recursos (perguntas, vendas) sao
 * detalhe do servidor e nao aparecem aqui. Nada fala com o marketplace
 * daqui (sem chamada remota, sem 429).
 *
 * Shopee: conta conectavel pela CDS, mas sem pack de agente ainda — a
 * tela diz isso e nao oferece "adicionar".
 *
 * Acoes externas ja vinculadas (catalogo de aplicativos) continuam
 * gerenciaveis aqui (nivel/remover); a busca generica nao e oferecida.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENDERECO_PARA_CONECTAR_CONTA, buscarApisDoAgente, definirContaDaApi,
  definirPermissaoDeFerramentaExterna, desvincularFerramentaExterna,
  type ApiDoAgenteUI, type AtivacaoDoAgenteUI,
} from "@/lib/ia/agentes-http";
import {
  adicionarPackAoAgente, definirCapacidadeDaApi, definirNivelDasCapacidadesDaApi, removerPackDoAgente,
} from "@/lib/ia/ferramentas-do-agente";
import { ICONE_ACAO_EXTERNA } from "@/lib/ia/icones-ferramentas";
import {
  INTEGRACOES_CDS, capacidadesVisiveisDaApi, contaEmUsoDaApi, contaSelecionadaDaApi, nivelDaApi,
  nivelParaLigar, nomeDaConta, planoDaApi,
  type IntegracaoCds, type ProjecaoDeCapacidades,
} from "@/lib/ia/agentes-gestao";
import SeletorDeNivel, { nivelDoPack } from "@/components/ia/agentes/SeletorDeNivel";
import estilos from "@/components/ia/agentes/agentes.module.css";

type Escrever = (acao: () => Promise<{ estado: string; mensagem?: string }>, falha: string) => Promise<boolean>;

function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

/** O interruptor aprovado da pagina Agentes (`.interruptor`), para capabilities. */
function Interruptor({
  ligado, aoMudar, rotulo, desabilitado,
}: { ligado: boolean; aoMudar: (v: boolean) => void; rotulo: string; desabilitado?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={ligado} aria-label={rotulo}
      disabled={desabilitado}
      onClick={() => aoMudar(!ligado)}
      className={cx(estilos.interruptor, ligado && estilos.interruptorLigado)}
    />
  );
}

/** Resultado de pack no formato que `escrever` entende. */
async function comoEscrita(p: Promise<{ estado: string; resposta?: { estado: string; mensagem?: string } }>) {
  const r = await p;
  return r.estado === "recusado" && r.resposta ? r.resposta : { estado: r.estado === "ok" ? "ok" : "falha" };
}

export default function ApisDoAgente({
  agenteId, ativacao, cap, ocupado, escrever, avisar,
}: {
  agenteId: string;
  ativacao: AtivacaoDoAgenteUI;
  cap: ProjecaoDeCapacidades;
  ocupado: boolean;
  escrever: Escrever;
  avisar: (mensagem: string) => void;
}) {
  const [apis, setApis] = useState<readonly ApiDoAgenteUI[] | null>(null);
  const [falhaLojas, setFalhaLojas] = useState(false);
  /** Integracao com a escolha de conta aberta (mais de uma conta possivel). */
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  /** Integracao aguardando o dono concluir o OAuth na outra aba. */
  const [aguardandoConta, setAguardandoConta] = useState<string | null>(null);
  const controlador = useRef<AbortController | null>(null);

  const recarregar = useCallback(async () => {
    controlador.current?.abort();
    const c = new AbortController();
    controlador.current = c;
    // F9.2-A2: UMA leitura — providers, contas do dono e a conta do agente.
    const x = await buscarApisDoAgente(agenteId, c.signal);
    if (c.signal.aborted) return null;
    if (x.estado !== "ok") { setFalhaLojas(true); return null; }
    setApis(x.apis);
    setFalhaLojas(false);
    return x.apis;
  }, [agenteId]);

  useEffect(() => {
    void recarregar();
    return () => controlador.current?.abort();
  }, [recarregar]);

  /** PATCH /apis: UMA conta para o provider; o servidor aplica tudo ou nada. */
  async function gravarContaDaApi(provedor: string, lojaId: string | null) {
    const r = await definirContaDaApi(agenteId, provedor, lojaId);
    if (r.estado === "ok") return { estado: "ok" };
    return r.estado === "conflito" || r.estado === "dados_invalidos" || r.estado === "inconsistente"
      ? { estado: "recusado", mensagem: r.mensagem } : { estado: "falha" };
  }

  /**
   * "Conectar" uma integracao neste agente: adiciona o pack (se faltar),
   * le os requisitos e aplica o plano. Automatico so com UMA conta possivel
   * por requisito; depois, UMA releitura valida o resultado.
   */
  async function conectar(integracao: IntegracaoCds, packPresente: boolean) {
    if (integracao.packId === null) return;
    if (!packPresente) {
      const ok = await escrever(() => comoEscrita(adicionarPackAoAgente(agenteId, integracao.packId as string, null)),
        `Não foi possível adicionar o ${integracao.nome}.`);
      if (!ok) return;
    }
    const lidas = await recarregar();
    const api = lidas?.find((a) => a.id === integracao.chave);
    if (!api) return;
    const plano = planoDaApi(api);
    if (plano.tipo === "auto") {
      const ok = await escrever(() => gravarContaDaApi(integracao.chave, plano.lojaId),
        `Não foi possível conectar a conta do ${integracao.nome}.`);
      // A validacao: uma releitura so — `utilizavel` e calculado pelo servidor.
      const depois = (await recarregar())?.find((a) => a.id === integracao.chave);
      if (ok && depois && planoDaApi(depois).tipo === "pronta") {
        const conta = depois.conexoes.find((l) => l.id === plano.lojaId);
        avisar(`${integracao.nome} conectado${conta ? ` com a conta ${nomeDaConta(conta)}` : ""}.`);
      }
      return;
    }
    if (plano.tipo === "escolher") setEscolhendo(integracao.chave);
    if (plano.tipo === "conectar_conta") setAguardandoConta(integracao.chave);
  }

  async function escolherConta(i: IntegracaoCds, lojaId: string | null) {
    await escrever(() => gravarContaDaApi(i.chave, lojaId), "Não foi possível salvar a conta escolhida.");
    await recarregar();
  }

  /** Botao/link que abre o fluxo de conexao de conta da CDS (aba nova). */
  const linkConectarConta = (i: IntegracaoCds, rotulo: string, primario: boolean) => (
    <a
      href={ENDERECO_PARA_CONECTAR_CONTA[i.marketplace]} target="_blank" rel="noopener noreferrer"
      className={cx(estilos.botao, primario && estilos.botaoPrimario)}
      onClick={() => setAguardandoConta(i.chave)}
    >
      {rotulo}
    </a>
  );

  return (
    <>
      <p className={estilos.dica}>Integrações da CDS que este agente pode usar.</p>
      {falhaLojas && (
        <p className={estilos.erro} role="alert">Não foi possível ler as contas conectadas agora.</p>
      )}
      <ul className={estilos.itens} aria-label="Integrações da CDS">
        {INTEGRACOES_CDS.map((i) => {
          const api = apis?.find((a) => a.id === i.chave) ?? null;
          const contas = api === null ? null : api.conexoes;
          const pack = i.packId === null ? null : cap.packsDeApi.find((f) => f.id === i.packId) ?? null;
          const plano = api === null ? null : planoDaApi(api);
          const semLoja = ativacao.conexoesSemLoja.some((c) => c.plataforma === i.plataforma);
          const pronta = pack !== null && !semLoja &&
            (plano === null || plano.tipo === "pronta" || plano.tipo === "sem_requisito");
          // F9.2-A3: SO as capabilities reais do catalogo, com o estado deste agente.
          const capacidades = api === null ? [] : capacidadesVisiveisDaApi(api);
          const ligadas = capacidades.filter((c) => c.habilitadaNoAgente).map((c) => c.id);
          const contaEmUso = api === null ? null : contaEmUsoDaApi(api);
          const semContaNaCds = contas !== null && contas.length === 0;

          return (
            <li key={i.chave} className={cx(estilos.item, estilos.integracao, pronta && estilos.integracaoAtiva)}>
              <span className={estilos.itemIcone} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={i.logo} alt="" />
              </span>
              <div className={estilos.itemTexto}>
                <span className={estilos.itemNome}>
                  {i.nome}
                  <span className={cx(estilos.selo, estilos.seloApi)}>API</span>
                  {i.packId === null
                    ? <span className={cx(estilos.selo, estilos.seloFraco)}>Ainda não disponível para agentes</span>
                    : pack === null
                      ? <span className={cx(estilos.selo, estilos.seloFraco)}>Não conectado a este agente</span>
                      : pronta
                        ? <span className={cx(estilos.selo, estilos.seloOk)}>● Conectado</span>
                        : <span className={cx(estilos.selo, estilos.seloAtencao)}>● Falta conectar a conta</span>}
                </span>
                <span className={estilos.itemSub}>{i.descricao}</span>
                <span className={estilos.itemConta}>
                  {contas === null ? (falhaLojas ? "Contas indisponíveis agora" : "Verificando contas…")
                    : contaEmUso ? <>Conta em uso: <strong className={estilos.nomeConta}>{nomeDaConta(contaEmUso)}</strong></>
                    : contas.length === 0 ? "Nenhuma conta conectada na CDS"
                    : contas.length === 1 ? <>Conta na CDS: <strong className={estilos.nomeConta}>{nomeDaConta(contas[0])}</strong></>
                    : `${contas.length} contas conectadas na CDS`}
                </span>
              </div>
              <div className={estilos.itemAcoes}>
                {i.packId === null ? (
                  // Sem pack de agente: so a conta, pelo fluxo da CDS.
                  semContaNaCds ? linkConectarConta(i, "Conectar conta", false) : null
                ) : pack === null ? (
                  semContaNaCds
                    ? linkConectarConta(i, "Conectar", true)
                    : (
                      <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                        disabled={ocupado || contas === null} onClick={() => void conectar(i, false)}>
                        Conectar
                      </button>
                    )
                ) : (
                  <>
                    <SeletorDeNivel
                      rotulo={`Quando o agente pode usar o ${i.nome}`}
                      valor={api === null ? nivelDoPack(pack) : nivelDaApi(api)} desabilitado={ocupado}
                      // F9.2-A3: o nivel vale para as capabilities LIGADAS (ou todas, se
                      // nenhuma estiver) — nunca religa uma que o dono desligou.
                      aoMudar={(n) => void escrever(() => comoEscrita(api === null
                        ? adicionarPackAoAgente(agenteId, pack.id, n)
                        : definirNivelDasCapacidadesDaApi(agenteId,
                            ligadas.length > 0 ? ligadas : capacidades.map((c) => c.id), n)),
                        "Não foi possível salvar a permissão.")}
                    />
                    {!pronta && (
                      semContaNaCds
                        ? linkConectarConta(i, "Conectar conta", true)
                        : (
                          <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                            disabled={ocupado || contas === null} onClick={() => void conectar(i, true)}>
                            Conectar
                          </button>
                        )
                    )}
                    {pronta && (contas?.length ?? 0) > 1 && escolhendo !== i.chave && (
                      <button type="button" className={estilos.botao} disabled={ocupado}
                        onClick={() => setEscolhendo(i.chave)}>
                        Trocar conta
                      </button>
                    )}
                    <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                      onClick={() => void escrever(() => removerPackDoAgente(agenteId, pack.id),
                        `Não foi possível remover o ${i.nome}.`).then(() => recarregar())}>
                      Remover
                    </button>
                  </>
                )}
              </div>

              {/* Capacidades do provider NESTE agente (F9.2-A3): so as reais, liga/desliga
                  pelo PATCH /permissoes de sempre. Desligar nao mexe na conta. */}
              {pack !== null && api !== null && capacidades.length > 0 && (
                <div className={estilos.integracaoDetalhe} aria-label={`Capacidades do ${i.nome}`}>
                  <span className={estilos.dica}>Capacidades</span>
                  {capacidades.map((c) => (
                    <div key={c.id} className={estilos.blocoLinha}>
                      <span className={estilos.itemSub}>{c.nome}</span>
                      <Interruptor
                        ligado={c.habilitadaNoAgente} rotulo={`${c.nome} no ${i.nome}`} desabilitado={ocupado}
                        aoMudar={(v) => void escrever(
                          () => comoEscrita(definirCapacidadeDaApi(agenteId, c.id, v, nivelParaLigar(api))),
                          v ? `Não foi possível ligar: ${c.nome}.` : `Não foi possível desligar: ${c.nome}.`,
                        ).then(() => recarregar())}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Escolha de conta: UM seletor por provider (F9.2-A2). */}
              {escolhendo === i.chave && api !== null && (
                <div className={estilos.integracaoDetalhe}>
                  <label className={estilos.campo} htmlFor={`ag-conta-${i.chave}`}>
                    <span className={estilos.campoRotulo}>Conta do {i.nome}</span>
                    {api.contaDoAgente.estado === "definida" && !api.contaDoAgente.utilizavel && (
                      <span className={estilos.itemAtencao}>A conta escolhida não serve para este uso. Escolha outra.</span>
                    )}
                    {api.contaDoAgente.estado === "divergente" && (
                      <span className={estilos.itemAtencao}>Este agente está com contas diferentes. Escolha uma.</span>
                    )}
                    <select id={`ag-conta-${i.chave}`} className={cx(estilos.entrada, estilos.selecao)} disabled={ocupado}
                      value={contaSelecionadaDaApi(api) ?? ""}
                      onChange={(e) => void escolherConta(i, e.target.value === "" ? null : e.target.value)}>
                      <option value="">Nenhuma</option>
                      {api.conexoes.map((l) => <option key={l.id} value={l.id}>{nomeDaConta(l)}</option>)}
                    </select>
                  </label>
                  <div>
                    <button type="button" className={estilos.botao} onClick={() => setEscolhendo(null)}>Concluir</button>
                  </div>
                </div>
              )}


              {/* Conta sendo conectada na outra aba (fluxo OAuth da CDS). */}
              {aguardandoConta === i.chave && (
                <div className={estilos.integracaoDetalhe} role="status">
                  <span className={estilos.dica}>
                    Conclua a autorização do {i.nome} na aba que abriu e volte aqui.
                  </span>
                  <div className={estilos.itemAcoes}>
                    {semContaNaCds && linkConectarConta(i, "Abrir autorização de novo", false)}
                    <button type="button" className={estilos.botao} disabled={ocupado}
                      onClick={() => { setAguardandoConta(null); void recarregar(); }}>
                      Já conectei — conferir
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {cap.externas.length > 0 && (
        <>
          <p className={estilos.blocoTitulo}>Outras integrações deste agente</p>
          <ul className={estilos.itens} aria-label="Outras integrações deste agente">
            {cap.externas.map((e) => (
              <li key={e.funcaoId} className={estilos.item}>
                <span className={estilos.itemIcone} aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ICONE_ACAO_EXTERNA} alt="" />
                </span>
                <div className={estilos.itemTexto}>
                  <span className={estilos.itemNome}>
                    {e.toolkit || "Integração externa"}
                    <span className={cx(estilos.selo, estilos.seloApi)}>API</span>
                    {e.nivel === null && <span className={cx(estilos.selo, estilos.seloAtencao)}>● Sem permissão definida</span>}
                  </span>
                  <span className={estilos.itemSub}>{e.acao.replace(/_/g, " ").toLowerCase()}</span>
                </div>
                <div className={estilos.itemAcoes}>
                  <SeletorDeNivel
                    rotulo={`Quando o agente pode usar ${e.toolkit}`}
                    valor={e.nivel} desabilitado={ocupado}
                    aoMudar={(n) => void escrever(() => definirPermissaoDeFerramentaExterna(agenteId, e.funcaoId, n),
                      "Não foi possível salvar a permissão.")}
                  />
                  <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                    onClick={() => void escrever(() => desvincularFerramentaExterna(agenteId, e.funcaoId),
                      "Não foi possível remover esta integração.")}>
                    Remover
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
