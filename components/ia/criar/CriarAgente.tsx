"use client";

/**
 * Criar agente — o fluxo de 6 etapas (F8.3-C2).
 *
 *   [ stepper ][ etapa atual            ][ Resumo do agente ]
 *              [ Voltar / Continuar     ]
 *
 * ── Sem backend novo ────────────────────────────────────────────────
 *
 * Mesma semantica do Wizard real (`components/ia/factory/Wizard.tsx`),
 * so reorganizada em 6 etapas visuais (mapa em `lib/ia/criar-agente.ts`):
 *
 *   - o agente NASCE ao sair da Identidade, INATIVO (`criarAgenteViaApi`
 *     com nome, funcao e instrucoes). As etapas seguintes gravam direto no
 *     backend (permissao, conta, memoria) — e precisam de onde gravar;
 *   - "Criar agente" no fim e a ATIVACAO (`definirAtivacaoDoAgente`), e
 *     quem decide se pode e o SERVIDOR (impedimentos reais);
 *   - abandonar no meio deixa um agente INATIVO, como sempre: ele nao roda
 *     e pode ser retomado em `/ia/agentes/novo?agente=<id>`.
 *
 * Skills, Arquivos, Rotinas e Testar sairam do fluxo inicial. Nada foi
 * apagado: o assistente de configuracao existente
 * (`/ia/agentes/<id>/configurar`) segue com Skills e Arquivos.
 *
 * ── Rascunho ────────────────────────────────────────────────────────
 *
 * Identidade e texto em edicao: so grava em "Continuar". Trocar de etapa
 * (stepper, voltar do navegador) com texto nao salvo pede confirmacao; fechar
 * a aba tambem (`beforeunload`). O resto grava na hora — sem prompt.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AJUDA_DO_NIVEL, PROVEDORES, rotuloDoNivel, type NivelDeTrabalho,
} from "@/lib/agentes/factory/catalogo-de-modelos";
import type { TipoAgenteUI } from "@/lib/ia/contratos";
import {
  atualizarAgenteViaApi, criarAgenteViaApi, definirAtivacaoDoAgente, definirIaDoAgente,
  lerAtivacaoDoAgente, lerMemoriaDoAgente, listarAgentes, listarMemoriasDoAgente,
  type AtivacaoDoAgenteUI, type EstadoDaMemoriaUI, type MemoriaDoAgenteUI,
} from "@/lib/ia/agentes-http";
import {
  ETAPAS_DE_CRIACAO, FUNCOES_DE_CRIACAO, destinosDoAgenteCriado, enderecoDoRascunho, etapaDoImpedimento,
  etapaValida, nomeDoProvedor, resumoDoAgente, rotuloDaFuncao, type NumeroDaEtapa,
} from "@/lib/ia/criar-agente";
import IconeDoAgente from "@/components/ia/agentes/IconeDoAgente";
import { IconeCadeado } from "@/components/ia/agentes/icones";
import EtapaApis from "@/components/ia/criar/EtapaApis";
import EtapaTools from "@/components/ia/criar/EtapaTools";
import EtapaMemoria from "@/components/ia/criar/EtapaMemoria";
import {
  IconeCheck, IconeInfo, IconeSetaDireita, IconeSetaEsquerda, cx, type ResultadoDeEscrita,
} from "@/components/ia/criar/comum";
import estilos from "@/components/ia/criar/criar.module.css";

const AVISO_RASCUNHO = "Há alterações não salvas nesta etapa. Sair dela e descartá-las?";

const CABECALHO: Record<NumeroDaEtapa, { titulo: string; sub: string }> = {
  1: { titulo: "Identidade do agente", sub: "Defina quem é o seu agente e como ele deve se comportar." },
  2: { titulo: "Modelo de IA", sub: "Escolha o provedor e o nível de trabalho do agente." },
  3: { titulo: "APIs", sub: "Serviços externos que o agente pode acessar. APIs são diferentes de Tools." },
  4: { titulo: "Tools", sub: "Ferramentas internas que o agente pode usar e como pode usá-las." },
  5: { titulo: "Memória", sub: "Defina se o agente lembra de contexto entre conversas." },
  6: { titulo: "Pronto para criar", sub: "Revise a configuração antes de criar o agente." },
};

function lerUrl(): { agente: string | null; etapa: NumeroDaEtapa | null } {
  if (typeof window === "undefined") return { agente: null, etapa: null };
  const q = new URLSearchParams(window.location.search);
  return { agente: q.get("agente"), etapa: etapaValida(q.get("etapa")) };
}

function frase(r: { estado: string; mensagem?: string }, padrao: string): string {
  if (r.estado === "nao_autenticado") return "Sua sessão expirou. Entre novamente.";
  if ((r.estado === "recusado" || r.estado === "dados_invalidos") && r.mensagem) return r.mensagem;
  return padrao;
}

export default function CriarAgente() {
  const [iniciando, setIniciando] = useState(true);
  const [agenteId, setAgenteId] = useState<string | null>(null);
  const [etapa, setEtapa] = useState<NumeroDaEtapa>(1);
  const [maxEtapa, setMaxEtapa] = useState<NumeroDaEtapa>(1);
  const [criado, setCriado] = useState(false);

  // Identidade: texto em edicao; `salvo` e o que o servidor tem.
  const [nome, setNome] = useState("");
  const [tipo, setTipo] = useState<TipoAgenteUI>("personalizado");
  const [instrucoes, setInstrucoes] = useState("");
  const [salvo, setSalvo] = useState<{ nome: string; instrucoes: string } | null>(null);

  const [ativacao, setAtivacao] = useState<AtivacaoDoAgenteUI | null>(null);
  const [falhaLeitura, setFalhaLeitura] = useState(false);
  const [motor, setMotor] = useState<EstadoDaMemoriaUI | null>(null);
  const [memorias, setMemorias] = useState<readonly MemoriaDoAgenteUI[] | null>(null);
  const [falhaMemorias, setFalhaMemorias] = useState(false);

  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  // ── Rascunho ──
  const identidadeSuja = agenteId === null
    ? nome.trim() !== "" || instrucoes.trim() !== ""
    : salvo !== null && (nome.trim() !== salvo.nome || instrucoes !== salvo.instrucoes);
  const rascunhoMemoria = useRef(false);
  const aoAlterarRascunhoMemoria = useCallback((tem: boolean) => { rascunhoMemoria.current = tem; }, []);
  const identidadeSujaRef = useRef(false);
  identidadeSujaRef.current = identidadeSuja;
  /** Lido NA HORA (o rascunho da memoria chega por efeito, sem render). */
  const temRascunho = useCallback(() => identidadeSujaRef.current || rascunhoMemoria.current, []);
  const etapaRef = useRef<NumeroDaEtapa>(1);
  etapaRef.current = etapa;
  const agenteRef = useRef<string | null>(null);
  agenteRef.current = agenteId;

  const reler = useCallback(async (id: string) => {
    const [a, m, l] = await Promise.all([lerAtivacaoDoAgente(id), lerMemoriaDoAgente(id, null), listarMemoriasDoAgente(id)]);
    if (a.estado === "ok") { setAtivacao(a.dados); setFalhaLeitura(false); } else setFalhaLeitura(true);
    if (m.estado === "ok") setMotor(m.dados);
    if (l.estado === "ok") { setMemorias(l.dados); setFalhaMemorias(false); } else setFalhaMemorias(true);
  }, []);

  // ── Entrada: novo, ou retomar um rascunho (?agente=<id>&etapa=<n>) ──
  useEffect(() => {
    let vivo = true;
    const { agente, etapa: pedida } = lerUrl();
    if (agente === null) { setIniciando(false); return; }
    void (async () => {
      const r = await listarAgentes();
      if (!vivo) return;
      const meu = r.estado === "ok" ? r.agentes.find((a) => a.id === agente) : undefined;
      if (meu === undefined) {
        setErro("Não encontramos esse rascunho. Comece um agente novo.");
        window.history.replaceState(null, "", "/ia/agentes/novo");
        setIniciando(false);
        return;
      }
      setAgenteId(meu.id);
      setNome(meu.nome);
      setTipo(meu.tipo);
      setInstrucoes(meu.instrucoes ?? "");
      setSalvo({ nome: meu.nome, instrucoes: meu.instrucoes ?? "" });
      if (meu.ativo) setCriado(true);
      const inicio = pedida ?? 1;
      setEtapa(inicio);
      setMaxEtapa(inicio);
      await reler(meu.id);
      if (vivo) setIniciando(false);
    })();
    return () => { vivo = false; };
  }, [reler]);

  // ── Navegacao entre etapas (com o voltar do navegador) ──
  const confirmarSaida = () => !temRascunho() || window.confirm(AVISO_RASCUNHO);

  function descartarIdentidade() {
    if (salvo !== null) { setNome(salvo.nome); setInstrucoes(salvo.instrucoes); }
  }

  function irPara(n: NumeroDaEtapa, opcoes: { semConfirmar?: boolean } = {}) {
    if (n === etapa) return;
    if (!opcoes.semConfirmar) {
      if (!confirmarSaida()) return;
      descartarIdentidade();
    }
    setErro(null);
    setAviso(null);
    setEtapa(n);
    setMaxEtapa((m) => (n > m ? n : m));
    if (agenteId !== null) window.history.pushState(null, "", enderecoDoRascunho(agenteId, n));
    window.scrollTo({ top: 0 });
  }

  useEffect(() => {
    const aoVoltar = () => {
      const { agente, etapa: pedida } = lerUrl();
      const atual = etapaRef.current;
      if (agente === null || agente !== agenteRef.current || pedida === null || pedida === atual) return;
      if (temRascunho() && !window.confirm(AVISO_RASCUNHO)) {
        window.history.pushState(null, "", enderecoDoRascunho(agente, atual));
        return;
      }
      setEtapa(pedida);
    };
    const aoSair = (e: BeforeUnloadEvent) => {
      if (!temRascunho()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("popstate", aoVoltar);
    window.addEventListener("beforeunload", aoSair);
    return () => {
      window.removeEventListener("popstate", aoVoltar);
      window.removeEventListener("beforeunload", aoSair);
    };
  }, [temRascunho]);

  // ── Escritas ──
  async function escrever(acao: () => Promise<ResultadoDeEscrita>, falha: string): Promise<boolean> {
    if (agenteId === null) return false;
    setErro(null);
    setAviso(null);
    setOcupado(true);
    try {
      const r = await acao();
      if (r.estado !== "ok") setErro(frase(r, falha));
      await reler(agenteId);
      return r.estado === "ok";
    } finally {
      setOcupado(false);
    }
  }

  /** Identidade: CRIA o agente (inativo) na primeira vez; depois, PATCH. */
  async function salvarIdentidade(): Promise<boolean> {
    setErro(null);
    if (nome.trim() === "") { setErro("Dê um nome ao agente."); return false; }
    setOcupado(true);
    try {
      if (agenteId === null) {
        const r = await criarAgenteViaApi({
          nome: nome.trim(), tipo, instrucoes: instrucoes.trim() === "" ? null : instrucoes,
        });
        if (r.estado !== "ok") { setErro(frase(r, "Não foi possível criar o agente.")); return false; }
        setAgenteId(r.agente.id);
        setSalvo({ nome: r.agente.nome, instrucoes: r.agente.instrucoes ?? "" });
        setNome(r.agente.nome);
        setInstrucoes(r.agente.instrucoes ?? "");
        // A URL passa a ter o id: refresh volta para ESTE fluxo, no rascunho.
        window.history.replaceState(null, "", enderecoDoRascunho(r.agente.id, 2));
        await reler(r.agente.id);
        return true;
      }
      if (salvo !== null && nome.trim() === salvo.nome && instrucoes === salvo.instrucoes) return true;
      const r = await atualizarAgenteViaApi(agenteId, { nome: nome.trim(), instrucoes });
      if (r.estado !== "ok") { setErro(frase(r, "Não foi possível salvar.")); return false; }
      setSalvo({ nome: r.agente.nome, instrucoes: r.agente.instrucoes ?? "" });
      setNome(r.agente.nome);
      setInstrucoes(r.agente.instrucoes ?? "");
      await reler(agenteId);
      return true;
    } finally {
      setOcupado(false);
    }
  }

  async function continuar() {
    if (etapa === 1) {
      if (!(await salvarIdentidade())) return;
      setEtapa(2);
      setMaxEtapa((m) => (m < 2 ? 2 : m));
      // Agente recem-criado: `salvarIdentidade` ja trocou a URL (replace).
      if (agenteRef.current !== null) window.history.pushState(null, "", enderecoDoRascunho(agenteRef.current, 2));
      return;
    }
    if (etapa < 6) irPara((etapa + 1) as NumeroDaEtapa, { semConfirmar: !temRascunho() });
  }

  /** "Criar agente": a ATIVACAO real. Quem decide e o servidor. */
  async function criarAgente() {
    if (agenteId === null) return;
    setErro(null);
    setOcupado(true);
    try {
      const r = await definirAtivacaoDoAgente(agenteId, true);
      if (r.estado !== "ok") {
        setErro(frase(r, "Não foi possível criar o agente."));
        await reler(agenteId);
        return;
      }
      await reler(agenteId);
      setCriado(true);
      window.history.replaceState(null, "", `/ia/agentes/novo?agente=${encodeURIComponent(agenteId)}`);
    } finally {
      setOcupado(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────

  if (iniciando) {
    return <div className={estilos.raiz}><p className={estilos.dica} role="status">Carregando…</p></div>;
  }

  if (criado && agenteId !== null) {
    const destino = destinosDoAgenteCriado(agenteId);
    return (
      <div className={estilos.raiz}>
        <div className={estilos.sucesso}>
          <div className={estilos.sucessoCartao} role="status">
            <span className={estilos.sucessoIcone}><IconeCheck tamanho={28} /></span>
            <div>
              <h2 className={estilos.sucessoTitulo}>Agente criado com sucesso</h2>
              <p className={estilos.dica}>Seu agente foi criado e já está pronto para trabalhar.</p>
            </div>
            <p className={estilos.sucessoNome}>{nome}</p>
            <div className={estilos.sucessoAcoes}>
              <Link href={destino.agentes} className={cx(estilos.botao, estilos.botaoPrimario)}>Ir para Agentes</Link>
              <Link href={destino.escritorio} className={estilos.botao}>Abrir no Escritório</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const resumo = resumoDoAgente({ nome, tipo, ativacao, memorias });
  const cab = CABECALHO[etapa];
  const precisaAgente = etapa !== 1;
  const prontoParaCriar = ativacao !== null && ativacao.podeAtivar;
  // "Concluida" = ja passou por ela E o servidor nao aponta pendencia nela.
  const etapasPendentes = new Set(ativacao === null || ativacao.ativo ? []
    : ativacao.impedimentos.map((i) => etapaDoImpedimento(i, ativacao)));

  // ── Etapa 1 ──
  const identidade = (
    <>
      <label className={estilos.campo}>
        <span className={estilos.rotulo}>Nome do agente</span>
        <input className={estilos.entrada} value={nome} maxLength={120} onChange={(e) => setNome(e.target.value)}
          placeholder="Ex.: Atendimento Mercado Livre" />
      </label>
      <div className={estilos.campo} role="radiogroup" aria-label="Função">
        <span className={estilos.rotulo}>
          Função
          {agenteId !== null && (
            <span className={estilos.rotuloDica}><IconeCadeado tamanho={13} />Definida na criação</span>
          )}
        </span>
        <div className={estilos.funcoes}>
          {FUNCOES_DE_CRIACAO.map((f) => (
            <button key={f.tipo} type="button" role="radio" aria-checked={tipo === f.tipo}
              disabled={agenteId !== null || ocupado}
              onClick={() => setTipo(f.tipo)}
              className={cx(estilos.funcao, tipo === f.tipo && estilos.funcaoAtiva)}>
              <IconeDoAgente tipo={f.tipo} usaMercadoLivre={false} tamanho="sm" />
              {f.rotulo}
            </button>
          ))}
        </div>
        <p className={estilos.dica}>
          {agenteId === null
            ? "A função identifica o agente na CDS e não pode ser trocada depois desta etapa. O que ele pode fazer é definido em APIs e Tools."
            : "A função foi definida na criação e não é editável."}
        </p>
      </div>
      <label className={estilos.campo}>
        <span className={estilos.rotulo}>
          Instruções <span className={estilos.rotuloDica}>{instrucoes.length} caracteres</span>
        </span>
        <textarea className={cx(estilos.entrada, estilos.areaTexto)} rows={9} value={instrucoes}
          onChange={(e) => setInstrucoes(e.target.value)}
          placeholder="Descreva como o agente deve agir, o tom das respostas e os limites." />
      </label>
      {agenteId === null && (
        <p className={estilos.nota}>
          <IconeInfo tamanho={14} />
          Ao continuar, o agente é salvo como rascunho inativo. Ele só começa a trabalhar quando
          você clicar em Criar agente, na última etapa.
        </p>
      )}
    </>
  );

  // ── Etapa 2 ──
  const modelo = ativacao === null ? null : (() => {
    const ofertas = ativacao.modelos;
    const provedores = [...new Set([...PROVEDORES, ...ofertas.map((m) => m.provedor)])];
    const escolhido = ofertas.find((m) => m.provedor === ativacao.provedorEscolhido) ?? null;
    const atualNivel = escolhido === null ? null : (ativacao.nivelDeTrabalho ?? escolhido.niveis[0] ?? null);
    return (
      <>
        {ativacao.iaDesfecho === "escolhida_indisponivel" && (
          <p className={estilos.erro} role="alert">
            A IA escolhida para este agente não está disponível agora. Escolha outra — nada é trocado automaticamente.
          </p>
        )}
        <div className={estilos.campo}>
          <span className={estilos.rotulo}>Provedor</span>
          <div role="radiogroup" aria-label="Provedor de IA" className={estilos.provedores}>
            {provedores.map((p) => {
              const oferta = ofertas.find((m) => m.provedor === p) ?? null;
              const ativo = ativacao.provedorEscolhido === p;
              return (
                <button key={p} type="button" role="radio" aria-checked={ativo}
                  disabled={oferta === null || ocupado}
                  onClick={() => { if (oferta !== null && !ativo) void escrever(() => definirIaDoAgente(agenteId as string, {
                    provedor: oferta.provedor, nivel: oferta.niveis.length > 1 ? oferta.niveis[0] : null,
                  }), "Não foi possível escolher a IA."); }}
                  className={cx(estilos.provedor, ativo && estilos.provedorAtivo)}>
                  <span aria-hidden="true" className={estilos.provedorMarca}>
                    {(oferta?.nome ?? nomeDoProvedor(p)).charAt(0).toUpperCase()}
                  </span>
                  <span className={estilos.provedorTexto}>
                    <span className={estilos.provedorNome}>{oferta?.nome ?? nomeDoProvedor(p)}</span>
                    <span className={estilos.provedorModelo}>{oferta?.modeloId ?? "Não configurado neste ambiente"}</span>
                    <span className={estilos.provedorEstado}>
                      {oferta === null ? "Indisponível" : ativo ? "Selecionado" : "Disponível"}
                      {oferta !== null && !oferta.ferramentas ? " · sem ferramentas" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {ofertas.length === 0 && <p className={estilos.erro}>Nenhuma IA está configurada neste ambiente.</p>}
        </div>
        <div className={estilos.campo}>
          <span className={estilos.rotulo}>Modelo atual</span>
          {escolhido === null ? (
            <p className={estilos.dica}>Escolha um provedor acima.</p>
          ) : (
            <div className={estilos.caixaInfo}>
              <span className={estilos.caixaInfoForte}>{escolhido.modeloId}</span>
              <span className={estilos.dica}>Configurado pela CDS para {escolhido.nome} — um modelo por provedor.</span>
            </div>
          )}
        </div>
        {escolhido !== null && escolhido.niveis.length > 1 && atualNivel !== null && (
          <div className={estilos.campo}>
            <span className={estilos.rotulo}>Nível de trabalho</span>
            <div role="radiogroup" aria-label="Nível de trabalho" className={estilos.segmentos}>
              {escolhido.niveis.map((n) => (
                <button key={n} type="button" role="radio" aria-checked={n === atualNivel} disabled={ocupado}
                  onClick={() => { if (n !== atualNivel) void escrever(() => definirIaDoAgente(agenteId as string, {
                    provedor: escolhido.provedor, nivel: n,
                  }), "Não foi possível mudar o nível."); }}
                  className={cx(estilos.segmento, n === atualNivel && estilos.segmentoAtivo)}>
                  {rotuloDoNivel(n)}
                </button>
              ))}
            </div>
            <p className={estilos.dica}>{(AJUDA_DO_NIVEL as Record<string, string>)[atualNivel as NivelDeTrabalho] ?? ""}</p>
          </div>
        )}
        {escolhido !== null && escolhido.niveis.length <= 1 && (
          <p className={estilos.dica}>Esta IA trabalha em um nível único — não há nível a ajustar.</p>
        )}
      </>
    );
  })();

  // ── Etapa 6 ──
  const linhaDe = (r: (typeof resumo)[number]["rotulo"]) => resumo.find((l) => l.rotulo === r)?.valor ?? null;
  const revisao = ativacao === null ? null : (
    <>
      <dl className={estilos.revisao}>
        <p className={estilos.revisaoNome}>{nome.trim() || "Novo agente"}</p>
        {([
          [1, "Identidade", `${rotuloDaFuncao(tipo)}${instrucoes.trim() === "" ? " · sem instruções" : ` · ${instrucoes.length} caracteres de instruções`}`],
          [2, "Modelo", linhaDe("Modelo de IA")],
          [3, "APIs", linhaDe("APIs")],
          [4, "Tools", linhaDe("Tools")],
          [5, "Memória", linhaDe("Memória")],
        ] as const).map(([n, rotulo, valor]) => (
          <div key={rotulo} className={estilos.revisaoLinha}>
            <dt className={estilos.revisaoRotulo}>{rotulo}</dt>
            <dd className={estilos.revisaoValor}>{valor ?? <span className={estilos.resumoVazio}>Não definido</span>}</dd>
            <button type="button" className={estilos.botaoLink} onClick={() => irPara(n)}>Editar</button>
          </div>
        ))}
      </dl>

      {!ativacao.ativo && ativacao.impedimentos.length > 0 && (
        <div className={estilos.atencao} role="alert">
          <strong>Falta isto para criar o agente:</strong>
          <ul className={estilos.impedimentos}>
            {ativacao.impedimentos.map((i) => {
              const destino = etapaDoImpedimento(i, ativacao);
              return (
                <li key={i.codigo} className={estilos.impedimento}>
                  <span>{i.mensagem}</span>
                  {destino !== null && destino !== 6 && (
                    <button type="button" className={estilos.botao} onClick={() => irPara(destino)}>
                      Resolver em {ETAPAS_DE_CRIACAO[destino - 1].titulo}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {prontoParaCriar && <p className={estilos.ok} role="status">Tudo certo para criar o agente.</p>}

      <p className={estilos.nota}>
        <IconeInfo tamanho={14} />
        Skills e Arquivos não fazem parte da criação. Por enquanto, eles continuam na configuração
        completa do agente, aberta pelo painel do agente no Escritório.
      </p>
    </>
  );

  const conteudo = etapa === 1 ? identidade
    : agenteId === null ? <p className={estilos.dica}>Conclua a Identidade para continuar.</p>
    : ativacao === null ? (
      <p className={estilos.dica} role="status">
        {falhaLeitura ? "Não foi possível carregar este agente agora." : "Carregando…"}
      </p>
    )
    : etapa === 2 ? modelo
    : etapa === 3 ? (
      <EtapaApis agenteId={agenteId} ativacao={ativacao} ocupado={ocupado} escrever={escrever}
        avisar={setAviso} aoMudarConexao={() => void reler(agenteId)} />
    )
    : etapa === 4 ? <EtapaTools agenteId={agenteId} ativacao={ativacao} ocupado={ocupado} escrever={escrever} />
    : etapa === 5 ? (
      <EtapaMemoria agenteId={agenteId} ativacao={ativacao} motor={motor} memorias={memorias}
        falhaMemorias={falhaMemorias} ocupado={ocupado} escrever={escrever} avisar={setAviso}
        aoAlterarRascunho={aoAlterarRascunhoMemoria} />
    )
    : revisao;

  return (
    <div className={estilos.raiz}>
      <div className={estilos.grade}>
        {/* ── Esquerda: stepper ── */}
        <nav aria-label="Etapas da criação" className={estilos.stepper}>
          <div>
            <h1 className={estilos.stepperTitulo}>Criar agente</h1>
            <p className={estilos.stepperSub}>Siga os passos para configurar seu agente de IA.</p>
          </div>
          <ol className={estilos.passos}>
            {ETAPAS_DE_CRIACAO.map((e) => {
              const atual = e.numero === etapa;
              const concluido = !atual && e.numero < maxEtapa && !etapasPendentes.has(e.numero);
              const alcancavel = !atual && (agenteId !== null ? e.numero <= maxEtapa : e.numero === 1);
              return (
                <li key={e.numero}
                  className={cx(estilos.passo, atual && estilos.passoAtual, concluido && estilos.passoConcluido,
                    !atual && !concluido && estilos.passoFuturo)}>
                  <button type="button" className={estilos.passoBotao} disabled={!alcancavel}
                    aria-current={atual ? "step" : undefined} onClick={() => irPara(e.numero)}>
                    <span className={estilos.passoNumero} aria-hidden="true">
                      {concluido ? <IconeCheck tamanho={14} /> : e.numero}
                    </span>
                    <span className={estilos.passoTexto}>
                      <span className={estilos.passoTitulo}>{e.titulo}</span>
                      <span className={estilos.passoSub}>{e.subtitulo}</span>
                    </span>
                    {concluido && <span className={estilos.somenteLeitor}>(concluída)</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* ── Centro: a etapa atual ── */}
        <section aria-labelledby="cr-etapa-titulo" className={estilos.etapa}>
          <div className={estilos.etapaCorpo}>
            <div>
              <h2 id="cr-etapa-titulo" className={estilos.etapaTitulo}>{cab.titulo}</h2>
              <p className={estilos.etapaSub}>{cab.sub}</p>
            </div>
            {erro !== null && <p className={estilos.erro} role="alert">{erro}</p>}
            {aviso !== null && <p className={estilos.ok} role="status">{aviso}</p>}
            {precisaAgente && agenteId === null ? null : conteudo}
          </div>
          <footer className={estilos.rodape}>
            {etapa > 1 ? (
              <button type="button" className={estilos.botao} disabled={ocupado}
                onClick={() => irPara((etapa - 1) as NumeroDaEtapa)}>
                <IconeSetaEsquerda tamanho={14} /> Voltar
              </button>
            ) : <span />}
            {etapa < 6 ? (
              <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)} disabled={ocupado}
                onClick={() => void continuar()}>
                {ocupado && etapa === 1 ? "Salvando…" : "Continuar"} <IconeSetaDireita tamanho={15} />
              </button>
            ) : (
              <button type="button" className={cx(estilos.botao, estilos.botaoPrimario)}
                disabled={ocupado || !prontoParaCriar} onClick={() => void criarAgente()}>
                {ocupado ? "Criando…" : "Criar agente"}
              </button>
            )}
          </footer>
        </section>

        {/* ── Direita: resumo persistente ── */}
        <aside aria-label="Resumo do agente" className={estilos.resumo}>
          <div className={estilos.resumoTopo}>
            <h2 className={estilos.resumoTitulo}>Resumo do agente</h2>
            <span className={cx(estilos.estado, prontoParaCriar && estilos.estadoPronto)}>
              {agenteId === null ? "Novo" : prontoParaCriar ? "Pronto para criar" : "Rascunho"}
            </span>
          </div>
          <dl className={estilos.resumoLista}>
            {resumo.map((l) => (
              <div key={l.rotulo} className={estilos.resumoLinha}>
                <dt className={estilos.resumoRotulo}>{l.rotulo}</dt>
                <dd className={cx(estilos.resumoValor, l.valor === null && estilos.resumoVazio)}>{l.valor ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </div>
  );
}
