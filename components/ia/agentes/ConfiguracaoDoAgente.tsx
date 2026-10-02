"use client";

/**
 * Configuracao de UM agente existente — F8.3-C1.
 *
 * Seis secoes (Geral, Modelo de IA, APIs, Tools, Memoria, Status), cada
 * uma sobre o contrato REAL que ja existe. Nenhuma regra nova:
 *
 *   Geral        `atualizarAgenteViaApi` — so `nome` e `instrucoes`. A
 *                Funcao (`tipo`) e SO LEITURA: o PATCH nao aceita `tipo`.
 *   Modelo de IA `ativacao.modelos` (catalogo do servidor, por env) e
 *                `definirIaDoAgente`. Modelo = um por provedor; exibido.
 *   APIs         PROJECAO VISUAL: o pack do Mercado Livre (ainda um
 *                TOOL_PACK no dominio) + acoes externas vinculadas, loja
 *                por `ConexoesAgente`. Mesmos contratos de sempre.
 *   Tools        so packs INTERNOS (`TOOL_PACKS` menos os de API), com
 *                `adicionarPackAoAgente` / `removerPackDoAgente`.
 *   Memoria      `memoria_ativa` + estado do motor (`lerMemoriaDoAgente`);
 *                memorias fixadas: listar/criar/editar texto/ligar/excluir
 *                (`/memorias`, PATCH `conteudo` | `ativo`, DELETE).
 *   Status       o estado canonico (`aparenciaDoAgente`) e ativar/desativar
 *                por `definirAtivacaoDoAgente`, que o servidor valida; cada
 *                impedimento leva a ABA onde se resolve (`abaDoImpedimento`).
 *
 * F8.3-C1.5: TUDO inline. Nenhum botao daqui navega para o assistente,
 * Workspace ou outra pagina de configuracao. Nova integracao de aplicativo
 * usa a MESMA `BuscaDeFerramentas` (modo `apenasExternas`).
 *
 * Toda escrita e imediata (como no assistente), exceto texto em edicao
 * (Geral, nova memoria, memoria em edicao), que tem botao de salvar e e
 * reportado a pagina como rascunho (`aoAlterarRascunho`).
 */
import { useCallback, useEffect, useState } from "react";
import { TOOL_PACKS, packPorId } from "@/lib/agentes/factory/catalogo-ui";
import { MAX_CONTEUDO_DA_MEMORIA } from "@/lib/agentes/memorias/tipos";
import { rotuloDoNivel } from "@/lib/agentes/factory/catalogo-de-modelos";
import { CORES_ESTADO } from "@/lib/ia/design";
import { ROTULO_FORA_DE_OPERACAO, VOCABULARIO_ESTADO, type AparenciaAgente } from "@/lib/ia/estados";
import type { AgenteUI } from "@/lib/ia/contratos";
import {
  alterarMemoriaDoAgente, atualizarAgenteViaApi, criarMemoriaDoAgente, definirAtivacaoDoAgente,
  definirIaDoAgente, definirMemoriaDoAgente, lerAtivacaoDoAgente,
  lerMemoriaDoAgente, listarMemoriasDoAgente, removerMemoriaDoAgente,
  type AtivacaoDoAgenteUI, type EstadoDaMemoriaUI, type MemoriaDoAgenteUI,
} from "@/lib/ia/agentes-http";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
import { iconeDoPack, ICONE_ACAO_EXTERNA } from "@/lib/ia/icones-ferramentas";
import {
  abaDoImpedimento, filtrarTools, nomeDoTipo, projetarCapacidades,
} from "@/lib/ia/agentes-gestao";
import ApisDoAgente from "@/components/ia/agentes/ApisDoAgente";
import SeletorDeNivel, { nivelDoPack } from "@/components/ia/agentes/SeletorDeNivel";
import { MenuDoAgente, StatusDoAgente } from "@/components/ia/agentes/CartaoDeAgente";
import IconeDoAgente from "@/components/ia/agentes/IconeDoAgente";
import estilos from "@/components/ia/agentes/agentes.module.css";
import { IconeAlerta, IconeBusca, IconeCadeado, IconeChave, IconePlug } from "@/components/ia/agentes/icones";

export const SECOES = ["Geral", "Modelo de IA", "APIs", "Tools", "Memória", "Status"] as const;
type Secao = (typeof SECOES)[number];

function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(" ");
}

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

/** Frase unica para o que nao tem contrato de escrita. */
export const SEM_CONTRATO = "Esta configuração ainda não pode ser alterada aqui.";

export default function ConfiguracaoDoAgente({
  agente, aparencia, aoMudar, aoAlterarRascunho,
}: {
  agente: AgenteUI;
  aparencia: AparenciaAgente;
  /** Avisa a pagina para reler a lista (cards). */
  aoMudar: () => void;
  /**
   * Avisa a pagina se ha texto digitado e NAO salvo (Geral, nova memoria,
   * memoria em edicao). A pagina pergunta antes de trocar de agente.
   */
  aoAlterarRascunho?: (temRascunho: boolean) => void;
}) {
  const [secao, setSecao] = useState<Secao>("Geral");
  const [ativacao, setAtivacao] = useState<AtivacaoDoAgenteUI | null>(null);
  const [falhaLeitura, setFalhaLeitura] = useState(false);
  const [memoria, setMemoria] = useState<EstadoDaMemoriaUI | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // Geral: texto em edicao, salvo por botao.
  const [nome, setNome] = useState(agente.nome);
  const [instrucoes, setInstrucoes] = useState(agente.instrucoes ?? "");
  const [termoTool, setTermoTool] = useState("");

  // Memorias fixadas: lista real + rascunhos locais (nova / em edicao).
  const [memorias, setMemorias] = useState<readonly MemoriaDoAgenteUI[] | null>(null);
  const [falhaMemorias, setFalhaMemorias] = useState(false);
  const [novaMemoria, setNovaMemoria] = useState("");
  const [editando, setEditando] = useState<{ id: string; texto: string } | null>(null);
  const [excluindo, setExcluindo] = useState<string | null>(null);

  const reler = useCallback(async () => {
    const [a, m, l] = await Promise.all([
      lerAtivacaoDoAgente(agente.id),
      lerMemoriaDoAgente(agente.id, null),
      listarMemoriasDoAgente(agente.id),
    ]);
    if (a.estado === "ok") { setAtivacao(a.dados); setFalhaLeitura(false); }
    else setFalhaLeitura(true);
    if (m.estado === "ok") setMemoria(m.dados);
    if (l.estado === "ok") { setMemorias(l.dados); setFalhaMemorias(false); }
    else setFalhaMemorias(true);
  }, [agente.id]);

  useEffect(() => { void reler(); }, [reler]);

  /** Uma escrita: trava, grava, rele a configuracao e a lista. */
  async function escrever(acao: () => Promise<{ estado: string; mensagem?: string }>, falha: string) {
    setErro(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await acao();
      if (r.estado !== "ok") {
        setErro(r.estado === "recusado" || r.estado === "dados_invalidos"
          ? (r.mensagem ?? falha) : falha);
      }
      await reler();
      aoMudar();
      return r.estado === "ok";
    } finally {
      setOcupado(false);
    }
  }

  const cap = ativacao === null ? null : projetarCapacidades(ativacao);
  const alteracoesGerais = nome.trim() !== agente.nome || instrucoes !== (agente.instrucoes ?? "");

  async function salvarGeral() {
    if (nome.trim() === "") { setErro("Dê um nome ao agente."); return; }
    const ok = await escrever(
      () => atualizarAgenteViaApi(agente.id, { nome: nome.trim(), instrucoes }),
      "Não foi possível salvar.");
    if (ok) setAviso("Alterações salvas.");
  }

  // ── Rascunho nao salvo: a pagina pergunta antes de trocar de agente ──
  const memoriaEmEdicao = editando === null ? null : memorias?.find((m) => m.id === editando.id) ?? null;
  const temRascunho = alteracoesGerais || novaMemoria.trim() !== "" ||
    (editando !== null && memoriaEmEdicao !== null && editando.texto.trim() !== memoriaEmEdicao.conteudo);

  useEffect(() => { aoAlterarRascunho?.(temRascunho); }, [temRascunho, aoAlterarRascunho]);
  // Desmontar (trocar de agente) limpa o aviso: o rascunho foi descartado de proposito.
  useEffect(() => () => aoAlterarRascunho?.(false), [aoAlterarRascunho]);

  // ── Memorias fixadas (contratos: listar/criar/PATCH conteudo|ativo/DELETE) ──
  async function criarMemoria() {
    const texto = novaMemoria.trim();
    if (texto === "") return;
    const ok = await escrever(() => criarMemoriaDoAgente(agente.id, {
      conteudo: texto, ordem: (memorias?.length ?? 0) + 1,
    }), "Não foi possível adicionar a memória.");
    if (ok) { setNovaMemoria(""); setAviso("Memória adicionada."); }
  }

  async function salvarEdicaoDaMemoria() {
    if (editando === null) return;
    const texto = editando.texto.trim();
    if (texto === "") { setErro("A memória não pode ficar vazia."); return; }
    const ok = await escrever(() => alterarMemoriaDoAgente(agente.id, editando.id, { conteudo: texto }),
      "Não foi possível salvar a memória.");
    if (ok) { setEditando(null); setAviso("Memória atualizada."); }
  }

  // ── Secoes ─────────────────────────────────────────────────────────

  const mlSemLoja = ativacao?.conexoesSemLoja.some((c) => c.plataforma === "mercado_livre") === true;

  const geral = (
    <div className={estilos.geral}>
      <div className={estilos.geralCampos}>
        <label className={estilos.campo}>
          <span className={estilos.campoRotulo}>Nome do agente</span>
          <input className={estilos.entrada} value={nome} maxLength={120}
            onChange={(e) => setNome(e.target.value)} />
        </label>
        <label className={estilos.campo}>
          <span className={estilos.campoRotulo}>
            Função <span className={estilos.campoDica}><IconeCadeado tamanho={13} />Não editável por enquanto</span>
          </span>
          {/* SO LEITURA: o PATCH de agente aceita apenas nome e instrucoes. */}
          <input className={cx(estilos.entrada, estilos.entradaSoLeitura)}
            value={nomeDoTipo(agente.tipo)} readOnly aria-readonly="true" title={SEM_CONTRATO} />
          <span className={estilos.contador}>{SEM_CONTRATO}</span>
        </label>
        <label className={estilos.campo}>
          <span className={estilos.campoRotulo}>Instruções</span>
          <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={6}
            value={instrucoes} onChange={(e) => setInstrucoes(e.target.value)} />
          {/* Sem limite inventado: o backend nao declara teto para instrucoes. */}
          <span className={estilos.contador}>{instrucoes.length} caracteres</span>
        </label>
      </div>

      {cap !== null && (
        <aside className={estilos.geralResumo} aria-label="Resumo das capacidades">
          <div className={estilos.resumoBloco}>
            <div className={estilos.resumoTopo}>
              <h3 className={estilos.resumoTitulo}>
                <IconePlug tamanho={14} /> APIs conectadas ({cap.totalApis})
              </h3>
              <button type="button" className={estilos.botao} onClick={() => setSecao("APIs")}>
                Gerenciar
              </button>
            </div>
            {cap.totalApis === 0 ? (
              <p className={estilos.resumoVazio}>Nenhuma API conectada.</p>
            ) : (
              <ul className={estilos.resumoLista}>
                {cap.packsDeApi.map((f) => (
                  <li key={f.id} className={estilos.resumoItem}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/logo-ml.svg" alt="" className={estilos.resumoLogo} />
                    <span className={estilos.resumoNome}>Mercado Livre</span>
                    <span className={cx(estilos.selo, mlSemLoja ? estilos.seloAtencao : estilos.seloOk)}>
                      {mlSemLoja ? "Falta loja" : "Conectado"}
                    </span>
                  </li>
                ))}
                {[...new Set(cap.externas.map((e) => e.toolkit || "Integração externa"))].map((t) => (
                  <li key={t} className={estilos.resumoItem}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={ICONE_ACAO_EXTERNA} alt="" className={estilos.resumoLogo} />
                    <span className={estilos.resumoNome}>{t}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={estilos.resumoBloco}>
            <div className={estilos.resumoTopo}>
              <h3 className={estilos.resumoTitulo}>
                <IconeChave tamanho={14} /> Tools ({cap.tools.length})
              </h3>
              <button type="button" className={estilos.botao} onClick={() => setSecao("Tools")}>
                Gerenciar
              </button>
            </div>
            {cap.tools.length === 0 ? (
              <p className={estilos.resumoVazio}>Nenhuma Tool neste agente.</p>
            ) : (
              <ul className={estilos.resumoLista}>
                {cap.tools.map((f) => (
                  <li key={f.id} className={estilos.resumoItem}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={iconeDoPack(f.id)} alt="" className={estilos.resumoLogo} />
                    <span className={estilos.resumoNome}>{f.nome}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      )}
    </div>
  );

  const modeloIa = ativacao === null ? null : (
    <>
      {ativacao.iaDesfecho === "escolhida_indisponivel" && (
        <p className={estilos.erro} role="alert">
          A IA escolhida para este agente não está disponível agora. Escolha outra — nada é
          trocado automaticamente.
        </p>
      )}
      <div className={estilos.campo}>
        <span className={estilos.campoRotulo}>Provedor</span>
        {ativacao.modelos.length === 0 ? (
          <p className={estilos.dica}>Nenhuma IA está configurada neste ambiente.</p>
        ) : (
          <div role="radiogroup" aria-label="Provedor de IA" className={estilos.opcoes}>
            {ativacao.modelos.map((m) => {
              const ativo = m.provedor === ativacao.provedorEscolhido ||
                (ativacao.provedorEscolhido === null && m.provedor === ativacao.provedor);
              return (
                <button
                  key={m.provedor} type="button" role="radio" aria-checked={ativo}
                  disabled={ocupado}
                  onClick={() => {
                    if (ativo && ativacao.provedorEscolhido !== null) return;
                    void escrever(() => definirIaDoAgente(agente.id, {
                      provedor: m.provedor, nivel: m.niveis.length > 1 ? m.niveis[0] : null,
                    }), "Não foi possível escolher a IA.");
                  }}
                  className={cx(estilos.opcao, ativo && estilos.opcaoAtiva)}
                >
                  <span aria-hidden="true" className={estilos.opcaoMarca}>
                    {m.nome.charAt(0).toUpperCase()}
                  </span>
                  <span className={estilos.opcaoTexto}>
                    <span className={estilos.opcaoNome}>{m.nome}</span>
                    {/* O modelo e o que o ambiente configurou — exibido, nao escolhido. */}
                    <span className={estilos.opcaoSub}>{m.modeloId}</span>
                    <span className={estilos.opcaoEstado}>
                      {ativo
                        ? (ativacao.provedorEscolhido === null ? "Padrão do ambiente" : "Selecionado")
                        : "Disponível"}
                      {m.ferramentas ? "" : " · sem ferramentas"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className={estilos.campo}>
        <span className={estilos.campoRotulo}>Modelo atual</span>
        <span className={estilos.dica}>
          {ativacao.modelo ?? "nenhum"} — definido pelo ambiente para este provedor.
        </span>
      </div>
      {(() => {
        const alvo = ativacao.modelos.find((m) => m.provedor === ativacao.provedorEscolhido);
        if (alvo === undefined) {
          return <p className={estilos.dica}>Escolha um provedor acima para ajustar o nível de trabalho.</p>;
        }
        if (alvo.niveis.length <= 1) {
          return <p className={estilos.dica}>Esta IA trabalha em um nível único — não há nada a ajustar.</p>;
        }
        const atual = ativacao.nivelDeTrabalho ?? alvo.niveis[0];
        return (
          <div className={estilos.campo}>
            <span className={estilos.campoRotulo}>Nível de trabalho</span>
            <div role="radiogroup" aria-label="Nível de trabalho" className={estilos.segmentos}>
              {alvo.niveis.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={n === atual}
                  disabled={ocupado}
                  onClick={() => { if (n !== atual) void escrever(
                    () => definirIaDoAgente(agente.id, { provedor: alvo.provedor, nivel: n }),
                    "Não foi possível mudar o nível."); }}
                  className={cx(estilos.segmento, n === atual && estilos.segmentoAtivo)}>
                  {rotuloDoNivel(n)}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </>
  );


  const apis = ativacao === null || cap === null ? null : (
    <ApisDoAgente
      agenteId={agente.id} ativacao={ativacao} cap={cap} ocupado={ocupado}
      escrever={escrever} avisar={setAviso}
    />
  );

  // Tools: SO packs internos (os de API ficam em APIs), com busca local no
  // catalogo real (`TOOL_PACKS`) — nada vai ao servidor para filtrar.
  const idsNoAgente = new Set(cap?.tools.map((t) => t.id) ?? []);
  const toolsVisiveis = filtrarTools(termoTool, TOOL_PACKS);
  const adicionadasVisiveis = cap === null ? [] : cap.tools.filter((t) =>
    toolsVisiveis.some((p) => p.id === t.id));
  const disponiveisVisiveis = toolsVisiveis.filter((p) => !idsNoAgente.has(p.id));

  const tools = ativacao === null || cap === null ? null : (
    <>
      <div className={cx(estilos.busca, estilos.buscaTools)}>
        <span className={estilos.buscaIcone}><IconeBusca tamanho={15} /></span>
        <input
          type="search" value={termoTool} onChange={(e) => setTermoTool(e.target.value)}
          placeholder="Buscar tools..." aria-label="Buscar tools"
        />
      </div>

      <p className={estilos.blocoTitulo}>
        Neste agente ({termoTool.trim() === "" ? cap.tools.length : `${adicionadasVisiveis.length} de ${cap.tools.length}`})
      </p>
      {cap.tools.length === 0 ? (
        <p className={estilos.vazio}>Nenhuma Tool neste agente.</p>
      ) : adicionadasVisiveis.length === 0 ? (
        <p className={estilos.dica}>Nenhuma Tool deste agente corresponde à busca.</p>
      ) : (
        <ul className={estilos.itens} aria-label="Tools neste agente">
          {adicionadasVisiveis.map((f) => (
            <li key={f.id} className={cx(estilos.item, estilos.itemAtivo)}>
              <span className={estilos.itemIcone} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={iconeDoPack(f.id)} alt="" />
              </span>
              <div className={estilos.itemTexto}>
                <span className={estilos.itemNome}>
                  {f.nome}
                  <span className={cx(estilos.selo, estilos.seloOk)}>● Adicionada</span>
                </span>
                <span className={estilos.itemSub}>{packPorId(f.id)?.descricao ?? ""}</span>
              </div>
              <div className={estilos.itemAcoes}>
                <SeletorDeNivel
                  rotulo={`Quando o agente pode usar ${f.nome}`}
                  valor={nivelDoPack(f)} desabilitado={ocupado}
                  aoMudar={(n) => void escrever(async () => {
                    const r = await adicionarPackAoAgente(agente.id, f.id, n);
                    return r.estado === "recusado" ? r.resposta : { estado: r.estado === "ok" ? "ok" : "falha" };
                  }, "Não foi possível salvar a permissão.")}
                />
                <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                  onClick={() => void escrever(async () => removerPackDoAgente(agente.id, f.id),
                    "Não foi possível remover esta Tool.")}>
                  Remover
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className={estilos.blocoTitulo}>Disponíveis ({disponiveisVisiveis.length})</p>
      {disponiveisVisiveis.length === 0 ? (
        <p className={estilos.dica}>{termoTool.trim() === ""
          ? "Todas as Tools disponíveis já estão neste agente."
          : `Nenhuma Tool disponível para “${termoTool.trim()}”.`}</p>
      ) : (
        <ul className={estilos.itens} aria-label="Tools disponíveis">
          {disponiveisVisiveis.map((p) => (
            <li key={p.id} className={estilos.item}>
              <span className={estilos.itemIcone} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={iconeDoPack(p.id)} alt="" />
              </span>
              <div className={estilos.itemTexto}>
                <span className={estilos.itemNome}>{p.nome}</span>
                <span className={estilos.itemSub}>{p.descricao}</span>
              </div>
              <div className={estilos.itemAcoes}>
                <button type="button" className={estilos.botao} disabled={ocupado}
                  onClick={() => void escrever(async () => {
                    const r = await adicionarPackAoAgente(agente.id, p.id, null);
                    return r.estado === "recusado" ? r.resposta : { estado: r.estado === "ok" ? "ok" : "falha" };
                  }, "Não foi possível adicionar esta Tool.")}>
                  + Adicionar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );

  const memoriaSecao = ativacao === null ? null : (
    <div className={estilos.bloco}>
      <div className={estilos.blocoLinha}>
        <div>
          <p className={estilos.blocoTitulo}>
            Memória automática {ativacao.memoriaAtiva ? "ativa" : "desativada"}
          </p>
          <p className={estilos.dica}>
            Este agente pode preservar contexto útil entre conversas. A memória de um agente nunca
            é vista por outro.
          </p>
        </div>
        <Interruptor
          ligado={ativacao.memoriaAtiva} rotulo="Memória automática"
          desabilitado={ocupado || memoria?.motorConfigurado === false}
          aoMudar={(v) => void escrever(() => definirMemoriaDoAgente(agente.id, v),
            "Não foi possível alterar a memória.")}
        />
      </div>
      <span className={cx(estilos.selo,
        memoria === null ? estilos.seloFraco : memoria.motorConfigurado ? estilos.seloOk : estilos.seloAtencao)}>
        ● {memoria === null ? "Verificando o motor de memória…"
          : memoria.motorConfigurado ? "Disponível" : "Não configurada neste ambiente"}
      </span>
    </div>
  );

  const ativasFixadas = memorias?.filter((m) => m.ativo).length ?? 0;
  const memoriasFixadas = (
    <div className={estilos.bloco} aria-label="Memórias fixadas">
      <div>
        <p className={estilos.blocoTitulo}>
          Memórias fixadas {memorias !== null && `(${ativasFixadas} ativa${ativasFixadas === 1 ? "" : "s"})`}
        </p>
        <p className={estilos.dica}>
          Instruções que você escreve à mão e o agente sempre considera. Use para corrigir algo que
          ele entendeu errado.
        </p>
      </div>
      <label className={estilos.campo}>
        <span className={estilos.campoRotulo}>Nova memória</span>
        <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={3}
          value={novaMemoria} maxLength={MAX_CONTEUDO_DA_MEMORIA}
          placeholder="Ex.: Quando eu pedir resumo financeiro, mostre o saldo primeiro."
          onChange={(e) => setNovaMemoria(e.target.value)} />
        <span className={estilos.contador}>{novaMemoria.length}/{MAX_CONTEUDO_DA_MEMORIA}</span>
      </label>
      <div>
        <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
          disabled={ocupado || novaMemoria.trim() === ""} onClick={() => void criarMemoria()}>
          + Adicionar memória
        </button>
      </div>
      {memorias === null ? (
        <p className={estilos.dica}>{falhaMemorias
          ? "Não foi possível carregar as memórias fixadas agora."
          : "Carregando memórias…"}</p>
      ) : memorias.length === 0 ? (
        <p className={estilos.vazio}>Nenhuma memória fixada neste agente.</p>
      ) : (
        <ul className={estilos.itens}>
          {memorias.map((m) => {
            const emEdicao = editando?.id === m.id;
            return (
              <li key={m.id} className={cx(estilos.item, !m.ativo && estilos.itemDesligado)}>
                <div className={estilos.itemTexto}>
                  {emEdicao ? (
                    <label className={estilos.campo}>
                      <span className={estilos.campoRotulo}>Editar memória</span>
                      <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={3}
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
                  {emEdicao ? (
                    <>
                      <button type="button" className={estilos.botao} disabled={ocupado}
                        onClick={() => setEditando(null)}>
                        Cancelar
                      </button>
                      <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                        disabled={ocupado || editando.texto.trim() === "" || editando.texto.trim() === m.conteudo}
                        onClick={() => void salvarEdicaoDaMemoria()}>
                        Salvar
                      </button>
                    </>
                  ) : excluindo === m.id ? (
                    <>
                      <button type="button" className={estilos.botao} disabled={ocupado}
                        onClick={() => setExcluindo(null)}>
                        Cancelar
                      </button>
                      <button type="button" className={cx(estilos.botao, estilos.botaoPerigo)} disabled={ocupado}
                        onClick={() => { setExcluindo(null); void escrever(
                          () => removerMemoriaDoAgente(agente.id, m.id), "Não foi possível excluir a memória."); }}>
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
                        onClick={() => void escrever(
                          () => alterarMemoriaDoAgente(agente.id, m.id, { ativo: !m.ativo }),
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
  );

  const statusSecao = ativacao === null ? null : (
    <>
      <div className={cx(estilos.bloco)}>
        <div className={estilos.blocoLinha}>
          <div>
            <span className={estilos.dica}>Estado atual</span>
            <div style={{ marginTop: 6 }}><StatusDoAgente aparencia={aparencia} /></div>
          </div>
          <span className={estilos.dica} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {ativacao.ativo ? "Agente ativo" : "Agente desativado"}
            <Interruptor
              ligado={ativacao.ativo} rotulo="Ativar agente" desabilitado={ocupado}
              aoMudar={(v) => void escrever(() => definirAtivacaoDoAgente(agente.id, v),
                v ? "Não foi possível ativar." : "Não foi possível desativar.")}
            />
          </span>
        </div>
      </div>
      {!ativacao.ativo && ativacao.impedimentos.length > 0 && (
        <div className={estilos.erro}>
          <strong>Falta isto para ativar:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {ativacao.impedimentos.map((i) => {
              // Resolve-se NESTA configuracao: o botao so troca de aba.
              const aba = abaDoImpedimento(i.codigo, ativacao);
              return (
                <li key={i.codigo}>
                  {i.mensagem}
                  {aba !== null && (
                    <>
                      {" "}
                      <button type="button" className={estilos.botao} onClick={() => setSecao(aba)}>
                        Resolver em {aba}
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className={estilos.campo}>
        <span className={estilos.campoRotulo}>Estados possíveis</span>
        <ul className={estilos.estados}>
          {(Object.keys(VOCABULARIO_ESTADO) as (keyof typeof VOCABULARIO_ESTADO)[]).map((e) => (
            <li key={e}>
              <span aria-hidden="true" className={estilos.statusPonto}
                style={{ background: CORES_ESTADO[e] }} />
              {VOCABULARIO_ESTADO[e].rotulo}
            </li>
          ))}
          <li>
            <span aria-hidden="true" className={cx(estilos.statusPonto, estilos.statusPontoVazado)}
              style={{ ["--ag-status" as string]: "#98a2b3" }} />
            {ROTULO_FORA_DE_OPERACAO}
          </li>
        </ul>
      </div>
    </>
  );

  const conteudo: Record<Secao, React.ReactNode> = {
    Geral: geral, "Modelo de IA": modeloIa, APIs: apis, Tools: tools,
    "Memória": memoriaSecao === null ? null : <>{memoriaSecao}{memoriasFixadas}</>,
    Status: statusSecao,
  };

  const precisaAtencao = !aparencia.foraDeOperacao &&
    (aparencia.estado === "aguardando_aprovacao" || aparencia.estado === "erro");

  return (
    <section aria-label={`Configuração de ${agente.nome}`} className={estilos.config}>
      <header className={estilos.configTopo}>
        <IconeDoAgente tipo={agente.tipo}
          usaMercadoLivre={(cap?.packsDeApi.length ?? 0) > 0} tamanho="lg" />
        <div className={estilos.configIdentidade}>
          <h2 className={estilos.configNome}>{agente.nome}</h2>
          <StatusDoAgente aparencia={aparencia} />
        </div>
        {/* Menu real: Abrir no Escritorio, conversa em tela cheia (nenhum de configuracao). */}
        <MenuDoAgente agente={agente} alinhar="abaixo" />
      </header>

      {precisaAtencao && (
        <div className={estilos.alerta} role="status">
          <IconeAlerta tamanho={16} />
          {aparencia.estado === "aguardando_aprovacao"
            ? "Há uma ação deste agente aguardando a sua aprovação."
            : "A última tarefa deste agente terminou com erro."}
        </div>
      )}

      <ul role="tablist" aria-label="Seções de configuração" className={estilos.abas}>
        {SECOES.map((s) => (
          <li key={s}>
            <button type="button" role="tab" aria-selected={s === secao}
              onClick={() => setSecao(s)}
              className={cx(estilos.aba, s === secao && estilos.abaAtiva)}>
              {s}
            </button>
          </li>
        ))}
      </ul>

      <div role="tabpanel" aria-label={secao} className={estilos.painel}>
        {erro !== null && <p className={estilos.erro} role="alert">{erro}</p>}
        {aviso !== null && <p className={estilos.ok} role="status">{aviso}</p>}
        {secao !== "Geral" && ativacao === null
          ? <p className={estilos.dica}>{falhaLeitura
              ? "Não foi possível carregar a configuração deste agente agora."
              : "Carregando…"}</p>
          : conteudo[secao]}
      </div>

      {secao === "Geral" && (
        <footer className={estilos.rodape}>
          <button type="button" className={estilos.botao} disabled={!alteracoesGerais || ocupado}
            onClick={() => { setNome(agente.nome); setInstrucoes(agente.instrucoes ?? ""); setErro(null); }}>
            Descartar
          </button>
          <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
            disabled={!alteracoesGerais || ocupado} onClick={() => void salvarGeral()}>
            {ocupado ? "Salvando…" : "Salvar alterações"}
          </button>
        </footer>
      )}
    </section>
  );
}
