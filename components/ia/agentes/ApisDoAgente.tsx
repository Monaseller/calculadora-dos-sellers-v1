"use client";

/**
 * Aba APIs da configuracao inline — F8.3-C1.6.
 *
 * APIs = INTEGRACOES DA CDS (Mercado Livre, Shopee), nao uma busca solta
 * de aplicativos. Cada integracao mostra duas coisas, das fontes reais:
 *
 *   conta na CDS   `listarLojasDoDono` (GET /api/lojas, o mesmo de
 *                  Configuracoes). Sem conta: "Conectar" abre o fluxo
 *                  OAuth da CDS numa aba nova — a pagina nao se perde.
 *   neste agente   o pack de agente da integracao (`adicionarPackAoAgente`
 *                  / `removerPackDoAgente`, nivel) e a conta escolhida
 *                  para cada requisito (`buscarConexoesDoAgente` /
 *                  `definirConexaoDoAgente`).
 *
 * "Conectar" com conta ja disponivel e AUTOMATICO quando so ha uma conta
 * possivel por requisito (`planoDeConexao`): um PATCH por requisito e UMA
 * releitura de validacao. Com mais de uma conta, o dono escolhe. Nada
 * fala com o marketplace daqui (sem chamada remota, sem 429).
 *
 * Shopee: conta conectavel pela CDS, mas sem pack de agente ainda — a
 * tela diz isso e nao oferece "adicionar".
 *
 * Acoes externas ja vinculadas (catalogo de aplicativos) continuam
 * gerenciaveis aqui (nivel/remover); a busca generica nao e oferecida.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENDERECO_PARA_CONECTAR_CONTA, buscarConexoesDoAgente, definirConexaoDoAgente,
  definirPermissaoDeFerramentaExterna, desvincularFerramentaExterna, listarLojasDoDono,
  type AtivacaoDoAgenteUI, type ConexaoRequisitoUI, type LojaDoDonoUI,
} from "@/lib/ia/agentes-http";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import { ICONE_ACAO_EXTERNA } from "@/lib/ia/icones-ferramentas";
import {
  INTEGRACOES_CDS, contasDaIntegracao, nomeDaConta, planoDeConexao,
  type IntegracaoCds, type ProjecaoDeCapacidades,
} from "@/lib/ia/agentes-gestao";
import SeletorDeNivel, { nivelDoPack } from "@/components/ia/agentes/SeletorDeNivel";
import estilos from "@/components/ia/agentes/agentes.module.css";

type Escrever = (acao: () => Promise<{ estado: string; mensagem?: string }>, falha: string) => Promise<boolean>;

const ROTULO_RECURSO: Readonly<Record<string, string>> = { perguntas: "Perguntas" };

function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
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
  const [lojas, setLojas] = useState<readonly LojaDoDonoUI[] | null>(null);
  const [falhaLojas, setFalhaLojas] = useState(false);
  const [conexoes, setConexoes] = useState<readonly ConexaoRequisitoUI[] | null>(null);
  /** Integracao com a escolha de conta aberta (mais de uma conta possivel). */
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  /** Integracao aguardando o dono concluir o OAuth na outra aba. */
  const [aguardandoConta, setAguardandoConta] = useState<string | null>(null);
  const controlador = useRef<AbortController | null>(null);

  const recarregar = useCallback(async () => {
    controlador.current?.abort();
    const c = new AbortController();
    controlador.current = c;
    const [l, x] = await Promise.all([listarLojasDoDono(c.signal), buscarConexoesDoAgente(agenteId, c.signal)]);
    if (c.signal.aborted) return null;
    if (l.estado === "ok") { setLojas(l.lojas); setFalhaLojas(false); } else setFalhaLojas(true);
    const lidas = x.estado === "ok" ? x.conexoes : null;
    if (lidas !== null) setConexoes(lidas);
    return lidas;
  }, [agenteId]);

  useEffect(() => {
    void recarregar();
    return () => controlador.current?.abort();
  }, [recarregar]);

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
    if (lidas === null) return;
    const plano = planoDeConexao(lidas, integracao.plataforma);
    if (plano.tipo === "auto") {
      const ok = await escrever(async () => {
        for (const g of plano.gravar) {
          const r = await definirConexaoDoAgente(agenteId, g);
          if (r.estado !== "ok") {
            return r.estado === "conflito" || r.estado === "dados_invalidos"
              ? { estado: "recusado", mensagem: r.mensagem } : { estado: "falha" };
          }
        }
        return { estado: "ok" };
      }, `Não foi possível conectar a conta do ${integracao.nome}.`);
      // A validacao: uma releitura so — `utilizavel` e calculado pelo servidor.
      const validadas = await recarregar();
      if (ok && validadas !== null && planoDeConexao(validadas, integracao.plataforma).tipo === "pronta") {
        const conta = lojas?.find((l) => l.id === plano.gravar[0].lojaId);
        avisar(`${integracao.nome} conectado${conta ? ` com a conta ${nomeDaConta(conta)}` : ""}.`);
      }
      return;
    }
    if (plano.tipo === "escolher") setEscolhendo(integracao.chave);
    if (plano.tipo === "conectar_conta") setAguardandoConta(integracao.chave);
  }

  async function escolherConta(c: ConexaoRequisitoUI, lojaId: string | null) {
    await escrever(async () => {
      const r = await definirConexaoDoAgente(agenteId, { plataforma: c.plataforma, recurso: c.recurso, lojaId });
      if (r.estado === "ok") return { estado: "ok" };
      return r.estado === "conflito" || r.estado === "dados_invalidos"
        ? { estado: "recusado", mensagem: r.mensagem } : { estado: "falha" };
    }, "Não foi possível salvar a conta escolhida.");
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
          const contas = lojas === null ? null : contasDaIntegracao(i, lojas);
          const pack = i.packId === null ? null : cap.packsDeApi.find((f) => f.id === i.packId) ?? null;
          const doAgente = conexoes?.filter((c) => c.plataforma === i.plataforma) ?? [];
          const plano = conexoes === null ? null : planoDeConexao(conexoes, i.plataforma);
          const semLoja = ativacao.conexoesSemLoja.some((c) => c.plataforma === i.plataforma);
          const pronta = pack !== null && !semLoja && (plano === null || plano.tipo === "pronta" || plano.tipo === "sem_requisito");
          const contaEmUso = doAgente
            .map((c) => c.lojasElegiveis.find((l) => l.id === c.lojaIdSelecionada && c.utilizavel))
            .find((l) => l !== undefined);
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
                      valor={nivelDoPack(pack)} desabilitado={ocupado}
                      aoMudar={(n) => void escrever(() => comoEscrita(adicionarPackAoAgente(agenteId, pack.id, n)),
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
                    {pronta && doAgente.length > 0 && (contas?.length ?? 0) > 1 && escolhendo !== i.chave && (
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

              {/* Escolha de conta (mais de uma possivel): selects no padrao CDS. */}
              {escolhendo === i.chave && doAgente.length > 0 && (
                <div className={estilos.integracaoDetalhe}>
                  {doAgente.map((c) => {
                    const id = `ag-conta-${i.chave}-${c.recurso}`;
                    return (
                      <label key={`${c.plataforma}:${c.recurso}`} className={estilos.campo} htmlFor={id}>
                        <span className={estilos.campoRotulo}>
                          Conta do {i.nome} · {ROTULO_RECURSO[c.recurso] ?? c.recurso}
                        </span>
                        {c.lojaIdSelecionada !== null && !c.utilizavel && (
                          <span className={estilos.itemAtencao}>A conta escolhida não serve para este uso. Escolha outra.</span>
                        )}
                        <select id={id} className={cx(estilos.entrada, estilos.selecao)} disabled={ocupado}
                          value={c.lojaIdSelecionada ?? ""}
                          onChange={(e) => void escolherConta(c, e.target.value === "" ? null : e.target.value)}>
                          <option value="">Nenhuma</option>
                          {c.lojasElegiveis.map((l) => <option key={l.id} value={l.id}>{nomeDaConta(l)}</option>)}
                        </select>
                      </label>
                    );
                  })}
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
