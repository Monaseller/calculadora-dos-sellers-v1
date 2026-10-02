"use client";

/**
 * Etapa 3 — APIs (F8.3-C2).
 *
 * Os MESMOS contratos e regras da aba APIs da pagina Agentes, no visual
 * do v0 aprovado:
 *
 *   conta na CDS   `listarLojasDoDono` (GET /api/lojas)
 *   usar no agente `adicionarPackAoAgente` / `removerPackDoAgente` do pack
 *                  do Mercado Livre (no dominio ainda e TOOL_PACK — a
 *                  separacao API x Tool aqui e VISUAL)
 *   conta escolhida `buscarConexoesDoAgente` / `definirConexaoDoAgente`,
 *                  automatico so com UMA conta possivel (`planoDeConexao`)
 *   conectar conta o fluxo OAuth da CDS, em aba nova
 *
 * Capacidades: so as Funcoes REAIS do pack aparecem como incluidas; o
 * resto do v0 (mensagens) aparece desabilitado, "Ainda não disponível".
 * Nada aqui e selecionavel sem efeito real.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ENDERECO_PARA_CONECTAR_CONTA, buscarConexoesDoAgente, definirConexaoDoAgente,
  definirPermissaoDeFerramentaExterna, desvincularFerramentaExterna, listarLojasDoDono,
  type AtivacaoDoAgenteUI, type ConexaoRequisitoUI, type LojaDoDonoUI,
} from "@/lib/ia/agentes-http";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import { ICONE_ACAO_EXTERNA } from "@/lib/ia/icones-ferramentas";
import { packPorId } from "@/lib/agentes/factory/catalogo-ui";
import {
  INTEGRACOES_CDS, contasDaIntegracao, nomeDaConta, planoDeConexao, projetarCapacidades,
  type IntegracaoCds,
} from "@/lib/ia/agentes-gestao";
import { CAPACIDADES_MERCADO_LIVRE } from "@/lib/ia/criar-agente";
import {
  IconeCheck, IconeMais, Interruptor, SeletorDeNivel, comoEscrita, cx, type Escrever,
} from "@/components/ia/criar/comum";
import estilos from "@/components/ia/criar/criar.module.css";

function nivelDoPack(f: { completo: boolean; nivel: string | null }): string | null {
  return f.completo ? f.nivel : null;
}

export default function EtapaApis({
  agenteId, ativacao, ocupado, escrever, avisar, aoMudarConexao,
}: {
  agenteId: string;
  ativacao: AtivacaoDoAgenteUI;
  ocupado: boolean;
  escrever: Escrever;
  avisar: (mensagem: string) => void;
  /** Avisa o fluxo de que a conta mudou (o resumo e a revisao releem). */
  aoMudarConexao: () => void;
}) {
  const cap = projetarCapacidades(ativacao);
  const [lojas, setLojas] = useState<readonly LojaDoDonoUI[] | null>(null);
  const [falhaLojas, setFalhaLojas] = useState(false);
  const [conexoes, setConexoes] = useState<readonly ConexaoRequisitoUI[] | null>(null);
  const [escolhendo, setEscolhendo] = useState<string | null>(null);
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

  /** Liga a integracao: pack (se faltar) -> requisitos -> plano. */
  async function usar(integracao: IntegracaoCds, packPresente: boolean) {
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
      // Validacao: UMA releitura — `utilizavel` e calculado pelo servidor.
      const validadas = await recarregar();
      if (ok && validadas !== null && planoDeConexao(validadas, integracao.plataforma).tipo === "pronta") {
        const conta = lojas?.find((l) => l.id === plano.gravar[0].lojaId);
        avisar(`${integracao.nome} conectado${conta ? ` com a conta ${nomeDaConta(conta)}` : ""}.`);
      }
      aoMudarConexao();
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
    aoMudarConexao();
  }

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
      {falhaLojas && <p className={estilos.erro} role="alert">Não foi possível ler as contas conectadas agora.</p>}
      <ul className={estilos.itens} aria-label="Integrações da CDS">
        {INTEGRACOES_CDS.map((i) => {
          const contas = lojas === null ? null : contasDaIntegracao(i, lojas);
          const pack = i.packId === null ? null : cap.packsDeApi.find((f) => f.id === i.packId) ?? null;
          const doAgente = conexoes?.filter((c) => c.plataforma === i.plataforma) ?? [];
          const plano = conexoes === null ? null : planoDeConexao(conexoes, i.plataforma);
          const semLoja = ativacao.conexoesSemLoja.some((c) => c.plataforma === i.plataforma);
          const pronta = pack !== null && !semLoja &&
            (plano === null || plano.tipo === "pronta" || plano.tipo === "sem_requisito");
          const contaEmUso = doAgente
            .map((c) => c.lojasElegiveis.find((l) => l.id === c.lojaIdSelecionada && c.utilizavel))
            .find((l) => l !== undefined);
          const semContaNaCds = contas !== null && contas.length === 0;
          const funcoesDoPack = i.packId === null ? [] : packPorId(i.packId)?.funcoes ?? [];

          return (
            <li key={i.chave} className={cx(estilos.item, pack !== null && estilos.itemAtivo)}>
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
                    : contas !== null && contas.length > 0
                      ? <span className={cx(estilos.selo, estilos.seloOk)}>● Conectado</span>
                      : <span className={cx(estilos.selo, estilos.seloFraco)}>○ Não conectado</span>}
                </span>
                <span className={estilos.itemSub}>
                  {contas === null ? (falhaLojas ? "Contas indisponíveis agora" : "Verificando contas…")
                    : contaEmUso ? <>Conta conectada: <strong className={estilos.nomeConta}>{nomeDaConta(contaEmUso)}</strong></>
                    : contas.length === 0 ? "Nenhuma conta conectada na CDS"
                    : contas.length === 1 ? <>Conta conectada: <strong className={estilos.nomeConta}>{nomeDaConta(contas[0])}</strong></>
                    : `${contas.length} contas conectadas na CDS`}
                </span>
              </div>

              <div className={estilos.itemAcoes}>
                {i.packId === null ? (
                  semContaNaCds ? linkConectarConta(i, "Conectar conta", false) : null
                ) : semContaNaCds && pack === null ? (
                  linkConectarConta(i, "Conectar", true)
                ) : (
                  <span className={estilos.rotuloInterruptor}>
                    Usar neste agente
                    <Interruptor
                      ligado={pack !== null} rotulo={`Usar ${i.nome} neste agente`}
                      desabilitado={ocupado || contas === null}
                      aoMudar={(v) => {
                        if (v) void usar(i, false);
                        else if (pack !== null) {
                          void escrever(() => removerPackDoAgente(agenteId, pack.id), `Não foi possível remover o ${i.nome}.`)
                            .then(() => recarregar()).then(() => aoMudarConexao());
                        }
                      }}
                    />
                  </span>
                )}
              </div>

              {/* Detalhe da integracao em uso: nivel, conta e capacidades REAIS. */}
              {pack !== null && (
                <div className={estilos.itemDetalhe}>
                  <div className={estilos.blocoLinha}>
                    <span className={estilos.dica}>Quando o agente pode usar o {i.nome}</span>
                    <SeletorDeNivel
                      rotulo={`Quando o agente pode usar o ${i.nome}`}
                      valor={nivelDoPack(pack)} desabilitado={ocupado}
                      aoMudar={(n) => void escrever(() => comoEscrita(adicionarPackAoAgente(agenteId, pack.id, n)),
                        "Não foi possível salvar a permissão.")}
                    />
                  </div>

                  {!pronta && (
                    <div className={estilos.atencao} role="status">
                      Falta escolher a conta do {i.nome} para este agente.
                      <div className={estilos.itemAcoes}>
                        {semContaNaCds
                          ? linkConectarConta(i, "Conectar conta", true)
                          : (
                            <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                              disabled={ocupado} onClick={() => void usar(i, true)}>
                              Conectar conta
                            </button>
                          )}
                      </div>
                    </div>
                  )}

                  {pronta && doAgente.length > 0 && (contas?.length ?? 0) > 1 && escolhendo !== i.chave && (
                    <div>
                      <button type="button" className={estilos.botao} disabled={ocupado}
                        onClick={() => setEscolhendo(i.chave)}>
                        Trocar conta
                      </button>
                    </div>
                  )}

                  {escolhendo === i.chave && doAgente.map((c) => {
                    const id = `cr-conta-${i.chave}-${c.recurso}`;
                    return (
                      <label key={`${c.plataforma}:${c.recurso}`} className={estilos.campo} htmlFor={id}>
                        <span className={estilos.rotulo}>Conta do {i.nome}</span>
                        <select id={id} className={cx(estilos.entrada, estilos.selecao)} disabled={ocupado}
                          value={c.lojaIdSelecionada ?? ""}
                          onChange={(e) => void escolherConta(c, e.target.value === "" ? null : e.target.value)}>
                          <option value="">Nenhuma</option>
                          {c.lojasElegiveis.map((l) => <option key={l.id} value={l.id}>{nomeDaConta(l)}</option>)}
                        </select>
                      </label>
                    );
                  })}
                  {escolhendo === i.chave && (
                    <div>
                      <button type="button" className={estilos.botao} onClick={() => setEscolhendo(null)}>Concluir</button>
                    </div>
                  )}

                  <fieldset className={estilos.capacidades} aria-label={`Capacidades do ${i.nome}`}>
                    {CAPACIDADES_MERCADO_LIVRE.map((c) => {
                      const real = c.funcao !== null && funcoesDoPack.includes(c.funcao);
                      return (
                        <span key={c.rotulo} className={cx(estilos.capacidade, !real && estilos.capacidadeOff)}
                          aria-disabled={!real}>
                          <span aria-hidden="true" className={cx(estilos.capacidadeMarca, real && estilos.capacidadeMarcaOn)}>
                            {real && <IconeCheck tamanho={11} />}
                          </span>
                          {c.rotulo}
                          {!real && <span className={cx(estilos.selo, estilos.seloFraco)}>Ainda não disponível</span>}
                        </span>
                      );
                    })}
                  </fieldset>
                  <p className={estilos.dica}>
                    As capacidades disponíveis entram juntas, somente leitura: o agente não responde,
                    não altera anúncios e não cancela nada.
                  </p>
                </div>
              )}

              {aguardandoConta === i.chave && (
                <div className={estilos.itemDetalhe} role="status">
                  <span className={estilos.dica}>Conclua a autorização do {i.nome} na aba que abriu e volte aqui.</span>
                  <div className={estilos.itemAcoes}>
                    <button type="button" className={estilos.botao} disabled={ocupado}
                      onClick={() => { setAguardandoConta(null); void recarregar().then(() => aoMudarConexao()); }}>
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
          <h3 className={estilos.secaoTitulo}>Outras integrações deste agente</h3>
          <ul className={estilos.itens} aria-label="Outras integrações deste agente">
            {cap.externas.map((e) => (
              <li key={e.funcaoId} className={cx(estilos.item, estilos.itemAtivo)}>
                <span className={estilos.itemIcone} aria-hidden="true">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ICONE_ACAO_EXTERNA} alt="" />
                </span>
                <div className={estilos.itemTexto}>
                  <span className={estilos.itemNome}>
                    {e.toolkit || "Integração externa"}
                    <span className={cx(estilos.selo, estilos.seloApi)}>API</span>
                  </span>
                  <span className={estilos.itemSub}>{e.acao.replace(/_/g, " ").toLowerCase()}</span>
                </div>
                <div className={estilos.itemAcoes}>
                  <SeletorDeNivel rotulo={`Quando o agente pode usar ${e.toolkit}`} valor={e.nivel} desabilitado={ocupado}
                    aoMudar={(n) => void escrever(() => definirPermissaoDeFerramentaExterna(agenteId, e.funcaoId, n),
                      "Não foi possível salvar a permissão.")} />
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

      {/* "+ Adicionar API" do v0: nao ha catalogo generico de APIs. O card
          existe, mas nao abre fluxo nenhum. */}
      <div className={estilos.adicionarApi}>
        <button type="button" className={estilos.botao} disabled aria-describedby="cr-api-mais">
          <IconeMais tamanho={14} /> Adicionar API
        </button>
        <span id="cr-api-mais">
          Hoje a CDS integra Mercado Livre e Shopee. Novas integrações aparecerão aqui.
        </span>
      </div>
    </>
  );
}
