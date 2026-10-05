"use client";

/**
 * O WIZARD da Agent Factory — F7b.1.
 *
 * ── UMA etapa editavel por vez ──────────────────────────────────────
 *
 * A tela antiga mostrava identidade, ferramentas, IA e memoria ao mesmo
 * tempo, e era por isso que parecia painel de administrador. Aqui o
 * centro tem SO a etapa atual; a esquerda diz onde a pessoa esta, a
 * direita e resumo read-only.
 *
 * ── Persistencia progressiva, e por que ela e assim ─────────────────
 *
 * O agente nasce na etapa 1, com `ativo = false`, e cada etapa grava
 * direto no backend. Nao existe "salvar" no rodape.
 *
 * O motivo e concreto: metade das etapas NAO tem onde ser guardada no
 * browser. Uma fonte e um arquivo no bucket; uma permissao e uma linha
 * que o guard le; uma Skill tem hash. Guardar isso em `useState` ate um
 * "salvar" final significaria um upload que existe na tela e nao no
 * banco — e um refresh apagaria trabalho de verdade.
 *
 * Como o agente nasce inativo, um rascunho pela metade e inofensivo: ele
 * nao roda, nao aparece como ativo, nao decide nada.
 *
 * ── Ativar e um ato separado ────────────────────────────────────────
 *
 * Salvar acontece sozinho; ATIVAR e um botao, e ele so funciona quando a
 * rota de ativacao diz que pode. A regra vive no servidor (ver
 * `lib/agentes/factory/ativacao.ts`), e esta tela apenas mostra o que
 * ele respondeu — nunca decide por conta propria.
 *
 * ── Zero rede aqui ──────────────────────────────────────────────────
 *
 * Nenhum `fetch`, nenhum endereco de API. Tudo passa por
 * `lib/ia/agentes-http.ts`, que e o unico ponto de rede desta area.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";
import {
  Alternador, AreaTexto, Aviso, Botao, Campo, Cartao, EscolhaUnica, Etiqueta,
  PainelLateral, TAMANHO,
} from "@/components/ui/Primitivas";
import { TOOL_PACKS } from "@/lib/agentes/factory/catalogo-ui";
import { adicionarPackAoAgente, removerPackDoAgente } from "@/lib/ia/ferramentas-do-agente";
// §6: "resolver inline usando o fluxo JA EXISTENTE". Este componente e o
// fluxo de escolher loja da area de Conexoes, montado aqui dentro. Uma
// segunda tela de escolha de loja divergiria da primeira.
import ConexoesAgente from "@/components/ia/agente/ConexoesAgente";
import { ChatDoAgente } from "@/components/ia/factory/ChatDoAgente";
import { ArquivosDoAgente } from "@/components/ia/factory/ArquivosDoAgente";
import { BuscaDeFerramentas } from "@/components/ia/factory/BuscaDeFerramentas";
import {
  alterarMemoriaDoAgente, atualizarAgenteViaApi, criarAgenteViaApi,
  criarMemoriaDoAgente, criarSkillDoDono, definirAtivacaoDoAgente,
  definirIaDoAgente, definirPermissaoDeFerramentaExterna,
  definirMemoriaDoAgente, lerAtivacaoDoAgente,
  listarAgentes, listarFontesDoAgente, listarMemoriasDoAgente,
  listarSkillsDoAgente, listarSkillsDoDono,
  removerMemoriaDoAgente, vincularSkillNoAgente,
  type AtivacaoDoAgenteUI, type FonteDoAgenteUI, type MemoriaDoAgenteUI,
  type RespostaDaFactory, type SkillDoAgenteUI,
} from "@/lib/ia/agentes-http";
import type { NivelAutonomia } from "@/lib/ia/conceitos";
// Os rotulos do nivel de trabalho vivem no catalogo, nao aqui: a tela
// nao pode ter a sua propria opiniao sobre o que cada nivel significa.
import { rotuloDoNivel } from "@/lib/agentes/factory/catalogo-de-modelos";

// ─── As etapas ────────────────────────────────────────────────────────

interface Etapa {
  readonly numero: number;
  readonly titulo: string;
  readonly obrigatoria: boolean;
}

/** Ordem CONGELADA pelo gate. Nao reordenar. */
const ETAPAS: readonly Etapa[] = Object.freeze([
  { numero: 1, titulo: "Identidade", obrigatoria: true },
  { numero: 2, titulo: "Instruções", obrigatoria: true },
  { numero: 3, titulo: "IA / Modelo", obrigatoria: true },
  { numero: 4, titulo: "Ferramentas", obrigatoria: false },
  { numero: 5, titulo: "Skills", obrigatoria: false },
  { numero: 6, titulo: "Memória", obrigatoria: false },
  { numero: 7, titulo: "Arquivos", obrigatoria: false },
  { numero: 8, titulo: "Permissões", obrigatoria: true },
  { numero: 9, titulo: "Rotinas", obrigatoria: false },
  { numero: 10, titulo: "Testar", obrigatoria: false },
  { numero: 11, titulo: "Revisar e Ativar", obrigatoria: true },
]);

type EstadoDaEtapa = "concluida" | "atual" | "vazia" | "atencao";

/** Simbolo alem de cor: o estado nao pode depender so de cor. */
const MARCA: Record<EstadoDaEtapa, string> = {
  concluida: "✓", atual: "●", vazia: "○", atencao: "!",
};
const COR: Record<EstadoDaEtapa, string> = {
  concluida: "#7ddba0", atual: CROMO.acento, vazia: CROMO.textoFraco, atencao: "#ffcc7a",
};

const NIVEIS: readonly { valor: NivelAutonomia; rotulo: string; ajuda: string }[] = [
  { valor: "automatico", rotulo: "Automático", ajuda: "O agente usa sem pedir." },
  { valor: "aprovacao", rotulo: "Pedir aprovação", ajuda: "Você aprova cada uso." },
  { valor: "bloqueado", rotulo: "Bloqueado", ajuda: "O agente não pode usar." },
];

/** Frase para um desfecho que nao e `ok`, sem vazar detalhe interno. */
function frasePorEstado(r: RespostaDaFactory<unknown>, padrao: string): string {
  if (r.estado === "nao_autenticado") return "Sua sessão expirou. Entre novamente.";
  if (r.estado === "nao_encontrado") return "Isto não foi encontrado.";
  if (r.estado === "recusado") return r.mensagem;
  return padrao;
}

export function Wizard({ agenteIdInicial }: { agenteIdInicial: string | null }) {
  const router = useRouter();
  const [agenteId, setAgenteId] = useState<string | null>(agenteIdInicial);
  const [etapa, setEtapa] = useState(1);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Identidade e instrucoes: estado local, gravado ao continuar.
  const [nome, setNome] = useState("");
  const [instrucoes, setInstrucoes] = useState("");

  const [ativacao, setAtivacao] = useState<AtivacaoDoAgenteUI | null>(null);
  const [memorias, setMemorias] = useState<readonly MemoriaDoAgenteUI[]>([]);
  const [fontes, setFontes] = useState<readonly FonteDoAgenteUI[]>([]);
  const [skillsDoAgente, setSkillsDoAgente] = useState<readonly SkillDoAgenteUI[]>([]);
  const [skillsDaBiblioteca, setSkillsDaBiblioteca] = useState<readonly SkillDoAgenteUI[]>([]);

  const [criarSkillAberto, setCriarSkillAberto] = useState(false);
  const [novaMemoria, setNovaMemoria] = useState("");

  // ── Carregamento ────────────────────────────────────────────────────

  const recarregar = useCallback(async (id: string) => {
    // Paralelo: as cinco leituras sao independentes, e encadea-las so
    // somaria espera.
    const [a, m, f, s, biblio] = await Promise.all([
      lerAtivacaoDoAgente(id),
      listarMemoriasDoAgente(id),
      listarFontesDoAgente(id, null),
      listarSkillsDoAgente(id),
      listarSkillsDoDono(),
    ]);
    if (a.estado === "ok") {
      setAtivacao(a.dados);
      setNome((atual) => (atual === "" ? a.dados.nome : atual));
    }
    if (m.estado === "ok") setMemorias(m.dados);
    if (f.estado === "ok") setFontes(f.dados.fontes);
    if (s.estado === "ok") setSkillsDoAgente(s.dados);
    if (biblio.estado === "ok") setSkillsDaBiblioteca(biblio.dados);
  }, []);

  useEffect(() => {
    if (agenteId !== null) void recarregar(agenteId);
  }, [agenteId, recarregar]);

  /**
   * Carrega nome e instrucoes do agente existente, uma vez.
   *
   * Le da LISTA e filtra pelo id, porque `/api/agentes/[agenteId]` expoe
   * SO `PATCH` — e de proposito. Aquela rota tem contrato fechado,
   * coberto por suite, e abrir um `GET` nela so para poupar um filtro
   * aqui tiraria a prova de que ela nao tem outra superficie. A lista ja
   * devolve `instrucoes` na projecao dela.
   */
  useEffect(() => {
    if (agenteId === null) return;
    let vivo = true;
    (async () => {
      const r = await listarAgentes();
      if (!vivo || r.estado !== "ok") return;
      const meu = r.agentes.find((a) => a.id === agenteId);
      if (meu === undefined) return;
      setNome((a) => (a === "" ? meu.nome : a));
      setInstrucoes((a) => (a === "" ? (meu.instrucoes ?? "") : a));
    })();
    return () => { vivo = false; };
  }, [agenteId]);

  // ── Escritas ────────────────────────────────────────────────────────

  async function salvarIdentidade(): Promise<boolean> {
    setErro(null);
    if (nome.trim() === "") { setErro("Dê um nome ao agente."); return false; }
    setSalvando(true);
    try {
      if (agenteId === null) {
        // O agente NASCE aqui, inativo. Antes disto nao ha o que gravar.
        // `tipo: "personalizado"` porque a Factory nao e atalho para um
        // dos seis tipos prontos: ela existe para o que a pessoa desenha.
        const r = await criarAgenteViaApi({
          nome: nome.trim(), tipo: "personalizado", instrucoes: null,
        });
        if (r.estado !== "ok") {
          setErro(r.estado === "dados_invalidos"
            ? r.mensagem
            : frasePorEstado(r, "Não foi possível criar o agente."));
          return false;
        }
        setAgenteId(r.agente.id);
        // A URL passa a ter o id: refresh volta para o mesmo rascunho.
        router.replace(`/ia/agentes/${r.agente.id}/configurar`);
        return true;
      }
      const r = await atualizarAgenteViaApi(agenteId, { nome: nome.trim() });
      if (r.estado !== "ok") {
        setErro(r.estado === "dados_invalidos"
          ? r.mensagem
          : frasePorEstado(r, "Não foi possível salvar."));
        return false;
      }
      await recarregar(agenteId);
      return true;
    } finally {
      setSalvando(false);
    }
  }

  async function salvarInstrucoes(): Promise<boolean> {
    if (agenteId === null) return false;
    setErro(null);
    setSalvando(true);
    try {
      const r = await atualizarAgenteViaApi(agenteId, { instrucoes });
      if (r.estado !== "ok") {
        setErro(r.estado === "dados_invalidos"
          ? r.mensagem
          : frasePorEstado(r, "Não foi possível salvar."));
        return false;
      }
      await recarregar(agenteId);
      return true;
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Grava o nivel de TODAS as Funcoes de um pack.
   *
   * Uma chamada por Funcao, porque o que o guard le e permissao POR
   * FUNCAO — o pack e a forma de pedir, nao a forma de guardar. E por
   * isso que a etapa 8 consegue dizer "faltam 2": o servidor sabe
   * quais, individualmente.
   *
   * Para no primeiro erro, de proposito: seguir gravando depois de uma
   * recusa deixaria o pack meio configurado sem ninguem avisado.
   */
  async function definirNivelDoPack(packId: string, nivel: NivelAutonomia | null) {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      // F8.2-A: a regra (uma permissao por Funcao, nivel sugerido pelo
      // EFEITO quando `nivel` e null — §28) saiu daqui para
      // `adicionarPackAoAgente`, que o Escritorio tambem usa. Mesmo laco,
      // mesma parada na primeira recusa; so mudou de casa.
      const r = await adicionarPackAoAgente(agenteId, packId, nivel);
      if (r.estado === "pack_desconhecido") return;
      if (r.estado === "recusado") {
        setErro(r.resposta.estado === "dados_invalidos"
          ? r.resposta.mensagem
          : frasePorEstado(r.resposta, "Não foi possível salvar a permissão."));
        return;
      }
      await recarregar(agenteId);
    } finally {
      setSalvando(false);
    }
  }

  /** F8.2-B: remove um pack (volta ao "nao selecionado"). Mesmo contrato do Escritorio. */
  async function removerPack(packId: string) {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await removerPackDoAgente(agenteId, packId);
      if (r.estado === "recusado") {
        setErro("Não foi possível remover esta ferramenta.");
        return;
      }
      await recarregar(agenteId);
    } finally {
      setSalvando(false);
    }
  }

  async function criarMemoria() {
    if (agenteId === null || novaMemoria.trim() === "") return;
    setErro(null);
    const r = await criarMemoriaDoAgente(agenteId, {
      conteudo: novaMemoria.trim(), ordem: memorias.length + 1,
    });
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível salvar a memória."));
      return;
    }
    setNovaMemoria("");
    await recarregar(agenteId);
  }

  /**
   * Liga ou desliga a memoria AUTOMATICA do agente.
   *
   * Nao confundir com `alternarMemoria`, que liga uma memoria FIXADA
   * especifica. Sao coisas diferentes: uma e o motor, a outra e um
   * bilhete que a pessoa escreveu.
   */
  async function alternarMemoriaLonga(ligado: boolean) {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await definirMemoriaDoAgente(agenteId, ligado);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível alterar a memória."));
        return;
      }
      await recarregar(agenteId);
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Grava a DECISAO do dono sobre UMA acao externa — F7b.4.2 §11/§16.
   *
   * Uma acao por vez, e nao um nivel para o grupo: cada acao externa e uma
   * capacidade distinta, e "Adicionar planilha" nao merece a mesma resposta
   * que "Ler planilha". Pack interno agrupa porque as Funcoes dele foram
   * desenhadas juntas; aqui nao ha esse desenho.
   */
  async function definirNivelExterno(funcaoId: string, nivel: NivelAutonomia) {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await definirPermissaoDeFerramentaExterna(agenteId, funcaoId, nivel);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível salvar a permissão."));
        return;
      }
      await recarregar(agenteId);
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Grava a escolha de IA — F7b.4.2 §7.
   *
   * O `modeloId` NAO e enviado: quem resolve o id concreto e o servidor, a
   * partir do catalogo que le env. A tela manda o provedor e, quando ha
   * mais de um, o nivel.
   *
   * Recarrega depois de gravar, e nao antes: o que a tela mostra passa a
   * ser o que o banco tem, e nao o que ela achou que ia acontecer.
   */
  async function escolherIa(provedor: string, nivel: string | null) {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await definirIaDoAgente(agenteId, { provedor, nivel });
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível escolher a IA."));
        return;
      }
      await recarregar(agenteId);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarMemoria(id: string, ativo: boolean) {
    if (agenteId === null) return;
    setErro(null);
    const r = await alterarMemoriaDoAgente(agenteId, id, { ativo });
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível alterar a memória."));
      return;
    }
    await recarregar(agenteId);
  }

  async function removerMemoria(id: string) {
    if (agenteId === null) return;
    setErro(null);
    const r = await removerMemoriaDoAgente(agenteId, id);
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível excluir a memória."));
      return;
    }
    await recarregar(agenteId);
  }



  async function vincularSkill(skillId: string) {
    if (agenteId === null) return;
    setErro(null);
    const r = await vincularSkillNoAgente(agenteId, skillId);
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível adicionar a Skill."));
      return;
    }
    await recarregar(agenteId);
  }

  async function ativar() {
    if (agenteId === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await definirAtivacaoDoAgente(agenteId, true);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível ativar."));
        // Recarrega de todo jeito: o servidor pode ter impedimento novo
        // a mostrar, e a lista da etapa 11 e dele, nao daqui.
        await recarregar(agenteId);
        return;
      }
      await recarregar(agenteId);
      // Ativou: o lugar da pessoa agora e o workspace, conversando.
      router.push(`/ia/agentes/${agenteId}`);
    } finally {
      setSalvando(false);
    }
  }

  // ── Estado de cada etapa, para o stepper ────────────────────────────

  function estadoDaEtapa(n: number): EstadoDaEtapa {
    if (n === etapa) return "atual";
    if (ativacao === null) return "vazia";
    if (n === 1) return ativacao.nome.trim() !== "" ? "concluida" : "vazia";
    if (n === 2) return ativacao.temInstrucoes ? "concluida" : "vazia";
    if (n === 3) {
      // F7b.4.2: escolha indisponivel NAO e etapa concluida, mesmo havendo
      // `provedor` — ele e a propria escolha que nao vale. E agente legado,
      // que nunca escolheu, continua concluido: o comportamento dele esta
      // preservado, e nao ha nada a corrigir.
      if (ativacao.iaDesfecho === "escolhida_indisponivel") return "atencao";
      return ativacao.provedor !== null ? "concluida" : "atencao";
    }
    if (n === 4) return ativacao.ferramentas.length > 0 ? "concluida" : "vazia";
    if (n === 5) return skillsDoAgente.length > 0 ? "concluida" : "vazia";
    // A etapa 6 esta "concluida" quando a memoria automatica esta ligada
    // OU quando ha memoria fixada: as duas sao formas de o agente
    // lembrar, e nenhuma e obrigatoria.
    if (n === 6) {
      return ativacao.memoriaAtiva || memorias.some((m) => m.ativo)
        ? "concluida" : "vazia";
    }
    if (n === 7) return fontes.length > 0 ? "concluida" : "vazia";
    if (n === 8) {
      if (ativacao.ferramentas.length === 0) return "vazia";
      return ativacao.ferramentas.every((f) => f.completo) ? "concluida" : "atencao";
    }
    if (n === 9) return "concluida";
    if (n === 11) return ativacao.ativo ? "concluida" : ativacao.podeAtivar ? "vazia" : "atencao";
    return "vazia";
  }

  const atual = ETAPAS[etapa - 1];

  async function continuar() {
    if (etapa === 1) { if (!(await salvarIdentidade())) return; }
    if (etapa === 2) { if (!(await salvarInstrucoes())) return; }
    setEtapa((n) => Math.min(ETAPAS.length, n + 1));
  }

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div
      className="factory-grade"
      style={{
        display: "grid",
        // Desktop: etapas | conteudo | resumo. Abaixo de 1100px o resumo
        // desce para a largura inteira; abaixo de 760px o stepper vira
        // uma faixa horizontal e o conteudo ocupa tudo.
        gridTemplateColumns: "minmax(200px, 240px) minmax(0, 1fr) minmax(220px, 280px)",
        gap: ESPACO.xl,
        alignItems: "start",
      }}
    >
      <style>{`
        @media (max-width: 1100px) {
          .factory-grade { grid-template-columns: minmax(180px, 220px) minmax(0, 1fr) !important; }
          .factory-resumo { grid-column: 1 / -1; }
        }
        @media (max-width: 760px) {
          .factory-grade { grid-template-columns: minmax(0, 1fr) !important; }
          .factory-etapas { flex-direction: row !important; overflow-x: auto; gap: 8px; }
          .factory-etapas button { white-space: nowrap; }
        }
      `}</style>

      {/* ── ESQUERDA: etapas ── */}
      <nav aria-label="Etapas da criação" className="factory-etapas"
        style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {ETAPAS.map((e) => {
          const st = estadoDaEtapa(e.numero);
          // Sem agente ainda, so a etapa 1 existe: nao ha onde gravar as
          // outras, e deixa-las clicaveis prometeria o que nao cumpre.
          const alcancavel = agenteId !== null || e.numero === 1;
          return (
            <button
              key={e.numero}
              type="button"
              onClick={() => { if (alcancavel) setEtapa(e.numero); }}
              aria-current={e.numero === etapa ? "step" : undefined}
              disabled={!alcancavel}
              style={{
                display: "flex", alignItems: "center", gap: ESPACO.sm,
                background: e.numero === etapa ? CROMO.acentoFundo : "transparent",
                border: `1px solid ${e.numero === etapa ? CROMO.acentoBorda : "transparent"}`,
                borderRadius: RAIO.controle,
                padding: `${ESPACO.sm}px ${ESPACO.md}px`,
                textAlign: "left", cursor: alcancavel ? "pointer" : "not-allowed",
                color: CROMO.texto, fontSize: TAMANHO.corpo,
                opacity: alcancavel ? 1 : 0.4,
              }}
            >
              <span aria-hidden="true" style={{ color: COR[st], width: 14, flexShrink: 0 }}>
                {MARCA[st]}
              </span>
              <span>{e.numero}. {e.titulo}</span>
            </button>
          );
        })}
      </nav>

      {/* ── CENTRO: a etapa atual, e SO ela ── */}
      <section aria-label={atual.titulo} style={{ minWidth: 0 }}>
        <h1 style={{
          margin: `0 0 ${ESPACO.lg}px`, fontSize: 22, color: CROMO.texto, fontWeight: 600,
        }}>
          {atual.titulo}
        </h1>

        <div style={{ display: "flex", flexDirection: "column", gap: ESPACO.lg }}>
          {erro !== null && <Aviso tom="erro">{erro}</Aviso>}

          {etapa === 1 && (
            <>
              <Campo
                rotulo="Nome do agente" valor={nome} aoMudar={setNome} obrigatorio
                placeholder="Ex.: Assistente financeiro"
                ajuda="O que este agente fará no seu dia a dia?"
                maxLength={120}
              />
              {agenteId === null && (
                <Aviso tom="info">
                  O agente é criado como <strong>rascunho</strong> e só funciona depois que você
                  ativar, no fim.
                </Aviso>
              )}
            </>
          )}

          {etapa === 2 && (
            <AreaTexto
              rotulo="Como este agente deve trabalhar?"
              valor={instrucoes} aoMudar={setInstrucoes} obrigatorio linhas={12}
              ajuda="Defina comportamento, regras e limites. Escreva como explicaria a uma pessoa nova."
              placeholder="Ex.: Você me ajuda a entender minhas finanças. Sempre use as ferramentas para qualquer número."
            />
          )}

          {etapa === 3 && (
            <>
              {/* O catalogo vem do SERVIDOR, e lista so o que este
                  ambiente de fato configurou. Um provedor sem chave nao
                  aparece — a tela nao oferece o que nao sustentaria. */}
              {/*
                F7b.4.2 §8: quando a escolha gravada nao esta disponivel, a
                tela DIZ — e nao troca por outra. O impedimento vem do
                servidor; aqui so mostramos que a escolha atual nao vale.
              */}
              {ativacao?.iaDesfecho === "escolhida_indisponivel" && (
                <Aviso tom="atencao">
                  A IA escolhida para este agente não está disponível agora. Escolha outra
                  abaixo para continuar — nada é trocado automaticamente.
                </Aviso>
              )}

              {(ativacao?.modelos.length ?? 0) === 0 ? (                <Aviso tom="atencao">
                  Nenhuma IA está configurada neste ambiente. Fale com o suporte antes de
                  continuar.
                </Aviso>
              ) : (
                ativacao?.modelos.map((m) => {
                  // `provedorEscolhido` e o que o dono GRAVOU. `provedor` e
                  // quem responde. A etiqueta distingue os dois, porque um
                  // agente legado responde por Claude sem ter escolhido.
                  const escolhido = m.provedor === ativacao.provedorEscolhido;
                  const emUso = m.provedor === ativacao.provedor;
                  return (
                    <Cartao key={m.provedor} destacado={escolhido}>
                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        gap: ESPACO.md, flexWrap: "wrap", alignItems: "flex-start",
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                            {m.nome}
                          </strong>
                          <p style={{
                            margin: `${ESPACO.xs}px 0 0`,
                            fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                          }}>
                            {m.descricao}
                          </p>
                          <details style={{ marginTop: ESPACO.sm }}>
                            <summary style={{
                              cursor: "pointer", fontSize: TAMANHO.miudo,
                              color: CROMO.textoFraco,
                            }}>
                              Detalhes técnicos
                            </summary>
                            <code style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                              {m.modeloId}
                            </code>
                          </details>
                        </div>
                        <div style={{
                          display: "flex", flexDirection: "column",
                          gap: ESPACO.xs, alignItems: "flex-end",
                        }}>
                          {escolhido && <Etiqueta tom="ok">Escolhida</Etiqueta>}
                          {!escolhido && emUso && <Etiqueta tom="info">Padrão</Etiqueta>}
                          {m.ferramentas
                            ? <Etiqueta tom="info">Usa ferramentas</Etiqueta>
                            : <Etiqueta tom="atencao">Sem ferramentas</Etiqueta>}
                          {!escolhido && (
                            <Botao tom="secundario" desabilitado={salvando}
                              onClick={() => void escolherIa(
                                m.provedor,
                                // Um nivel so: nao ha escolha a fazer, e
                                // mandar o unico disponivel e o mesmo que
                                // nao mandar nada.
                                m.niveis.length > 1 ? m.niveis[0] : null)}>
                              Usar esta
                            </Botao>
                          )}
                        </div>
                      </div>
                    </Cartao>
                  );
                })
              )}

              {/* §35/§36: o nivel de trabalho aparece SO quando a IA
                  ESCOLHIDA suporta mais de um. Um radio de uma opcao pede
                  atencao para nada — e oferecer um nivel que o provedor
                  nao tem seria prometer capacidade nao provada. */}
              {(() => {
                // Pela ESCOLHIDA, e nao pela que responde: um agente
                // legado nao escolheu nada, e nao tem nivel a ajustar.
                const alvo = ativacao?.modelos.find(
                  (m) => m.provedor === ativacao.provedorEscolhido);
                if (alvo === undefined) {
                  return (
                    <p style={{ margin: 0, fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                      Escolha uma IA acima para ajustar o nível de trabalho.
                    </p>
                  );
                }
                if (alvo.niveis.length <= 1) {
                  // F7b.4.3 §22: a frase diz o que e VERDADE do ponto de
                  // vista de quem usa — esta IA roda num nivel so aqui —,
                  // sem afirmar que o provedor nao tem controle nenhum. A
                  // medicao mostrou que a Anthropic TEM, e que o Gemini
                  // NAO; uma frase so, honesta nos dois casos.
                  return (
                    <p style={{ margin: 0, fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                      Esta IA trabalha em um nível único. Não há nada a ajustar aqui.
                    </p>
                  );
                }
                return (
                  <EscolhaUnica
                    rotulo="Nível de trabalho"
                    opcoes={alvo.niveis.map((n) => ({
                      valor: n, rotulo: rotuloDoNivel(n),
                    }))}
                    // O gravado quando existe. Nunca um default nosso
                    // desenhado como se fosse escolha do dono.
                    valor={ativacao?.nivelDeTrabalho ?? alvo.niveis[0]}
                    aoMudar={(n) => void escolherIa(alvo.provedor, n)}
                  />
                );
              })()}
            </>
          )}

          {etapa === 4 && (
            agenteId !== null
              ? <>
                  <p style={{ margin: 0, fontSize: TAMANHO.corpo, color: CROMO.textoFraco }}>
                    Escolha o que este agente sabe usar. <em>Quando</em> ele pode usar é a
                    etapa 8.
                  </p>
                  {/* A busca substituiu os cartoes fixos. Manter os dois
                      mostraria a mesma ferramenta duas vezes — a busca
                      sem termo ja lista todas as internas. */}
                  <BuscaDeFerramentas
                    agenteId={agenteId}
                    aoMudar={() => void recarregar(agenteId)}
                    packSelecionado={(chave) =>
                      ativacao?.ferramentas.some((f) => f.id === chave) === true}
                    aoAdicionarPack={(chave) => void definirNivelDoPack(chave, null)}
                    aoRemoverPack={(chave) => void removerPack(chave)}
                  />
                </>
              : <Aviso tom="info">Conclua a etapa 1 para escolher ferramentas.</Aviso>
          )}

          {etapa === 5 && (
            <>
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", gap: ESPACO.md, flexWrap: "wrap",
              }}>
                <p style={{ margin: 0, fontSize: TAMANHO.corpo, color: CROMO.textoFraco }}>
                  Skills são especialidades reutilizáveis entre agentes.
                </p>
                <Botao tom="secundario" onClick={() => setCriarSkillAberto(true)}>
                  + Criar Skill
                </Botao>
              </div>

              {skillsDoAgente.length > 0 && (
                <div>
                  <h2 style={{
                    fontSize: TAMANHO.corpo, color: CROMO.texto, margin: `0 0 ${ESPACO.sm}px`,
                  }}>
                    Neste agente
                  </h2>
                  {skillsDoAgente.map((s) => (
                    <Cartao key={s.id} destacado>
                      <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                        {s.nome}
                      </strong>
                      <p style={{
                        margin: `${ESPACO.xs}px 0 0`,
                        fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                      }}>
                        {s.descricao}
                      </p>
                    </Cartao>
                  ))}
                </div>
              )}

              <div>
                <h2 style={{
                  fontSize: TAMANHO.corpo, color: CROMO.texto, margin: `0 0 ${ESPACO.sm}px`,
                }}>
                  Sua biblioteca
                </h2>
                {skillsDaBiblioteca.length === 0 && (
                  <p style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco, margin: 0 }}>
                    Você ainda não tem Skills. Crie a primeira acima.
                  </p>
                )}
                {skillsDaBiblioteca
                  .filter((s) => !skillsDoAgente.some((d) => d.id === s.id))
                  .map((s) => (
                    <Cartao key={s.id}>
                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        gap: ESPACO.md, flexWrap: "wrap",
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                            {s.nome}
                          </strong>
                          <p style={{
                            margin: `${ESPACO.xs}px 0 0`,
                            fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                          }}>
                            {s.descricao}
                          </p>
                        </div>
                        <Botao tom="secundario" desabilitado={agenteId === null}
                          onClick={() => void vincularSkill(s.id)}>
                          Adicionar
                        </Botao>
                      </div>
                    </Cartao>
                  ))}
              </div>
            </>
          )}

          {etapa === 6 && (
            <>
              {/* §20/§28: a experiencia principal e UM interruptor. O que
                  ele liga e a memoria AUTOMATICA: o agente passa a
                  lembrar do que foi conversado, sem ninguem digitar
                  nada. */}
              <Alternador
                rotulo="Memória do agente"
                ligado={ativacao?.memoriaAtiva === true}
                aoMudar={(v) => void alternarMemoriaLonga(v)}
                descricao="Quando ativada, este agente poderá lembrar informações úteis de conversas anteriores e adaptar respostas ao longo do tempo."
              />

              {ativacao?.memoriaAtiva === true && (
                <Aviso tom="ok">
                  Ativa — aprendendo com as conversas deste agente. A memória de um agente
                  nunca é vista por outro.
                </Aviso>
              )}

              {/* §23/§27: a memoria manual da F6 nao foi apagada. Ela
                  deixou de ser o fluxo principal e virou correcao —
                  aquilo que a pessoa quer FIXAR, em vez de esperar que o
                  agente aprenda. */}
              <details>
                <summary style={{
                  cursor: "pointer", fontSize: TAMANHO.corpo, color: CROMO.texto,
                }}>
                  Avançado: memórias fixadas ({memorias.filter((m) => m.ativo).length})
                </summary>
                <p style={{
                  margin: `${ESPACO.sm}px 0`, fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                }}>
                  Instruções que você escreve à mão e o agente sempre considera. Use para
                  corrigir algo que ele entendeu errado.
                </p>
              <AreaTexto
                rotulo="Nova memória" valor={novaMemoria} aoMudar={setNovaMemoria} linhas={3}
                placeholder="Ex.: Quando eu pedir resumo financeiro, mostre o saldo primeiro."
                maxLength={2000}
              />
              <Botao tom="primario"
                desabilitado={agenteId === null || novaMemoria.trim() === ""}
                onClick={() => void criarMemoria()}>
                + Adicionar memória
              </Botao>
              {memorias.map((m) => (
                <Cartao key={m.id}>
                  <div style={{
                    display: "flex", justifyContent: "space-between",
                    gap: ESPACO.md, flexWrap: "wrap",
                  }}>
                    <span style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                      {m.conteudo}
                    </span>
                    <div style={{ display: "flex", gap: ESPACO.xs, flexShrink: 0 }}>
                      <Botao tom="sutil" onClick={() => void alternarMemoria(m.id, !m.ativo)}>
                        {m.ativo ? "Desativar" : "Ativar"}
                      </Botao>
                      <Botao tom="perigo" onClick={() => void removerMemoria(m.id)}>
                        Excluir
                      </Botao>
                    </div>
                  </div>
                </Cartao>
              ))}
              </details>
            </>
          )}

          {etapa === 7 && (
            agenteId !== null
              ? <ArquivosDoAgente agenteId={agenteId} aoMudar={() => void recarregar(agenteId)} />
              : <Aviso tom="info">Conclua a etapa 1 para adicionar arquivos.</Aviso>
          )}

          {etapa === 8 && (
            <>
              <p style={{ margin: 0, fontSize: TAMANHO.corpo, color: CROMO.textoFraco }}>
                <strong style={{ color: CROMO.texto }}>Ferramentas</strong> é o que ele sabe usar.{" "}
                <strong style={{ color: CROMO.texto }}>Permissões</strong> é quando ele pode usar.
              </p>
              {(ativacao?.ferramentas.length ?? 0) === 0 &&
                (ativacao?.ferramentasExternas.length ?? 0) === 0 && (
                <Aviso tom="info">
                  Nenhuma ferramenta escolhida. Volte à etapa 4 se quiser adicionar.
                </Aviso>
              )}
              {ativacao?.ferramentas.map((f) => {
                const pack = TOOL_PACKS.find((p) => p.id === f.id);
                return (
                  <Cartao key={f.id}>
                    <div style={{ marginBottom: ESPACO.md }}>
                      <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                        {f.nome}
                      </strong>
                      {!f.completo && (
                        <div style={{ marginTop: ESPACO.xs }}>
                          <Etiqueta tom="atencao">
                            {f.faltando === 1
                              ? "1 ferramenta sem permissão definida"
                              : `${f.faltando} ferramentas sem permissão definida`}
                          </Etiqueta>
                        </div>
                      )}
                    </div>
                    <EscolhaUnica
                      rotulo={`Quando o agente pode usar ${f.nome}?`}
                      opcoes={NIVEIS}
                      valor={(f.nivel as NivelAutonomia | null) ?? null}
                      aoMudar={(v) => void definirNivelDoPack(f.id, v)}
                      recomendado={
                        pack !== undefined && pack.acesso === "leitura" && !pack.exigeConexao
                          ? "automatico" : undefined
                      }
                    />
                  </Cartao>
                );
              })}

              {/*
                F7b.4.2 §16: as acoes de aplicativo aparecem AQUI, uma por
                uma, e com o nivel em branco ate o dono decidir. Foi isso
                que o gate corrigiu: antes, adicionar a acao ja gravava um
                nivel escolhido por nos a partir do risco.
              */}
              {(ativacao?.ferramentasExternas.length ?? 0) > 0 && (
                <p style={{
                  margin: `${ESPACO.md}px 0 0`, fontSize: TAMANHO.corpo, color: CROMO.texto,
                }}>
                  <strong>Ações de aplicativos</strong>
                </p>
              )}
              {ativacao?.ferramentasExternas.map((e) => (
                <Cartao key={e.funcaoId}>
                  <div style={{ marginBottom: ESPACO.md }}>
                    <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                      {e.toolkit}
                    </strong>
                    <p style={{
                      margin: `${ESPACO.xs}px 0 0`,
                      fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                    }}>
                      {e.acao.replace(/_/g, " ").toLowerCase()}
                    </p>
                    {e.nivel === null && (
                      <div style={{ marginTop: ESPACO.xs }}>
                        <Etiqueta tom="atencao">Sem permissão definida</Etiqueta>
                      </div>
                    )}
                  </div>
                  <EscolhaUnica
                    rotulo="Quando o agente pode usar esta ação?"
                    opcoes={NIVEIS}
                    // `null` de verdade: o radio nasce VAZIO, e a pessoa
                    // escolhe. Pre-marcar a sugestao faria o default voltar
                    // a ocupar o lugar da decisao.
                    valor={(e.nivel as NivelAutonomia | null) ?? null}
                    aoMudar={(v) => void definirNivelExterno(e.funcaoId, v)}
                    recomendado={
                      e.risco === "leitura" ? "automatico" : "aprovacao"
                    }
                  />
                </Cartao>
              ))}
            </>
          )}

          {etapa === 9 && (
            <>
              <EscolhaUnica
                rotulo="Como este agente será iniciado?"
                opcoes={[{
                  valor: "manual" as const, rotulo: "Manualmente",
                  ajuda: "Você conversa com ele quando quiser.",
                }]}
                valor="manual"
                aoMudar={() => undefined}
              />
              <p style={{ margin: 0, fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                Agendamento e disparo automático ainda não existem nesta versão. Este agente será
                iniciado quando você conversar com ele.
              </p>
            </>
          )}

          {etapa === 10 && (
            agenteId !== null
              ? <div style={{ height: "min(62vh, 620px)" }}>
                  <ChatDoAgente agenteId={agenteId} conversaId={null} modoTeste />
                </div>
              : <Aviso tom="info">Conclua a etapa 1 para testar.</Aviso>
          )}

          {etapa === 11 && ativacao !== null && (
            <>
              <Cartao>
                {([
                  ["Agente", ativacao.nome === "" ? "—" : ativacao.nome],
                  ["IA", ativacao.modelo ?? "não configurada"],
                  ["Ferramentas",
                    ativacao.ferramentas.map((f) => f.nome).join(", ") || "nenhuma"],
                  ["Skills", skillsDoAgente.map((s) => s.nome).join(", ") || "nenhuma"],
                  ["Memória", ativacao.memoriaAtiva
                ? `automática${memorias.filter((m) => m.ativo).length > 0
                    ? ` + ${memorias.filter((m) => m.ativo).length} fixada(s)` : ""}`
                : memorias.filter((m) => m.ativo).length > 0
                  ? `${memorias.filter((m) => m.ativo).length} fixada(s)`
                  : "desligada"],
                  ["Arquivos", `${fontes.length} arquivo(s)`],
                  // §10: a linha que faltava. "Mercado Livre — Monamor"
                  // diz o que o dono precisa conferir; "1 conexao" nao.
                  ["Integrações", ativacao.integracoes.length === 0
                    ? "nenhuma necessária"
                    : ativacao.integracoes
                        .map((i) => `${i.nome}${i.loja === null ? "" : ` — ${i.loja}`}`)
                        .join(", ")],
                  ["Pendências", ativacao.impedimentos.length === 0
                    ? "nenhuma"
                    : `${ativacao.impedimentos.length} a resolver`],
                  ["Modo", "Manual"],
                ] as const).map(([k, v]) => (
                  <div key={k} style={{
                    display: "flex", justifyContent: "space-between", gap: ESPACO.md,
                    padding: `${ESPACO.sm}px 0`, borderBottom: `1px solid ${CROMO.bordaSutil}`,
                  }}>
                    <span style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>{k}</span>
                    <span style={{
                      fontSize: TAMANHO.corpo, color: CROMO.texto, textAlign: "right",
                    }}>
                      {v}
                    </span>
                  </div>
                ))}
              </Cartao>

              {/*
                ── §5: a Skill pediu, e o botao esta aqui ──────────────
                A dependencia e DECLARADA pela Skill (`requer.funcoes`),
                e nao adivinhada do texto dela — §4. O que aparece e o
                nome do pack; `funcao_id` nao entra em frase nenhuma.
              */}
              {ativacao.dependenciasDeSkill
                .filter((d) => d.bloqueia && d.packId !== null)
                .map((d) => (
                  <div key={`${d.skillId}-${d.packId}`} style={{
                    marginTop: ESPACO.md, padding: ESPACO.md,
                    border: `1px solid ${CROMO.acentoBorda}`,
                    borderRadius: RAIO.card, background: CROMO.acentoFundo,
                  }}>
                    <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                      Esta Skill precisa de {d.nome}
                    </strong>
                    <p style={{
                      margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
                      fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                    }}>
                      A Skill <strong style={{ color: CROMO.texto }}>{d.skillId}</strong>{" "}
                      declara precisar desta capacidade. Sem ela, ela entra no agente
                      pedindo um trabalho que ele não consegue fazer.
                    </p>
                    <div style={{ display: "flex", gap: ESPACO.sm, flexWrap: "wrap" }}>
                      <Botao tom="primario" desabilitado={salvando}
                        onClick={() => void definirNivelDoPack(d.packId as string, null)}>
                        Adicionar {d.nome}
                      </Botao>
                      {/* A outra saida e remover a Skill, e ela vive na
                          etapa 5 — levar para la e voltar e o fluxo, e
                          nao um desvio para tela tecnica. */}
                      <Botao tom="secundario" desabilitado={salvando}
                        onClick={() => setEtapa(5)}>
                        Rever as Skills
                      </Botao>
                    </div>
                  </div>
                ))}

              {/* Requisito opcional NAO bloqueia — o contrato de Skill
                  separa `funcoes` de `funcoes_opcionais`, e reprovar por
                  uma opcional barraria um agente util. Vira aviso. */}
              {ativacao.dependenciasDeSkill.some((d) => !d.bloqueia) && (
                <Aviso tom="info">
                  Uma Skill deste agente menciona capacidades opcionais que ele não tem:{" "}
                  {[...new Set(ativacao.dependenciasDeSkill
                    .filter((d) => !d.bloqueia).map((d) => d.nome))].join(", ")}.
                  Ele funciona sem elas, com alcance menor.
                </Aviso>
              )}

              {/*
                ── §6/§11: escolher a loja AQUI ────────────────────────
                A ferramenta ja esta no agente e falta dizer de qual loja.
                A tela de Conexoes continua existindo para auditoria (§12),
                mas nao e requisito do fluxo normal.
              */}
              {ativacao.conexoesSemLoja.length > 0 && agenteId !== null && (
                <div style={{
                  marginTop: ESPACO.md, padding: ESPACO.md,
                  border: `1px solid ${CROMO.acentoBorda}`,
                  borderRadius: RAIO.card, background: CROMO.acentoFundo,
                }}>
                  <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                    Falta escolher a loja
                  </strong>
                  <p style={{
                    margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
                    fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                  }}>
                    {[...new Set(ativacao.conexoesSemLoja.map((c) => c.nome))].join(", ")}:
                    sua conta já está conectada na CDS. Só preciso saber de qual
                    loja este agente deve falar.
                  </p>
                  <ConexoesAgente agenteId={agenteId} />
                  <div style={{ marginTop: ESPACO.sm }}>
                    <Botao tom="secundario" desabilitado={salvando}
                      onClick={() => void recarregar(agenteId)}>
                      Já escolhi — conferir
                    </Botao>
                  </div>
                </div>
              )}

              {ativacao.impedimentos.length > 0 && (
                <Aviso tom="atencao">
                  <strong>Falta isto para ativar:</strong>
                  <ul style={{ margin: `${ESPACO.sm}px 0 0`, paddingLeft: ESPACO.lg }}>
                    {ativacao.impedimentos.map((i) => (
                      <li key={i.codigo} style={{ marginBottom: 4 }}>
                        {i.mensagem}{" "}
                        <button type="button" onClick={() => setEtapa(i.etapa)}
                          style={{
                            background: "none", border: "none", padding: 0,
                            color: CROMO.acento, cursor: "pointer", fontSize: TAMANHO.miudo,
                            textDecoration: "underline",
                          }}>
                          ir para a etapa {i.etapa}
                        </button>
                      </li>
                    ))}
                  </ul>
                </Aviso>
              )}

              {ativacao.ativo ? (
                <Aviso tom="ok">Este agente está ativo.</Aviso>
              ) : (
                <Botao tom="primario" largura="cheia"
                  desabilitado={!ativacao.podeAtivar || salvando}
                  onClick={() => void ativar()}>
                  Ativar agente
                </Botao>
              )}
            </>
          )}
        </div>

        {/* Rodape de navegacao */}
        <div style={{
          display: "flex", justifyContent: "space-between", gap: ESPACO.md,
          marginTop: ESPACO.xl, paddingTop: ESPACO.lg,
          borderTop: `1px solid ${CROMO.bordaSutil}`,
        }}>
          <Botao tom="secundario" desabilitado={etapa === 1}
            onClick={() => setEtapa((n) => Math.max(1, n - 1))}>
            ← Voltar
          </Botao>
          <div style={{ display: "flex", gap: ESPACO.sm }}>
            {!atual.obrigatoria && etapa < ETAPAS.length && (
              <Botao tom="sutil" onClick={() => setEtapa((n) => n + 1)}>
                Pular por enquanto
              </Botao>
            )}
            {etapa < ETAPAS.length && (
              <Botao tom="primario" desabilitado={salvando} onClick={() => void continuar()}>
                {salvando ? "Salvando..." : "Continuar →"}
              </Botao>
            )}
          </div>
        </div>
      </section>

      {/* ── DIREITA: resumo read-only ── */}
      <aside aria-label="Resumo do agente" className="factory-resumo">
        <Cartao>
          <div style={{ display: "flex", flexDirection: "column", gap: ESPACO.sm }}>
            <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
              {nome.trim() === "" ? "Novo agente" : nome}
            </strong>
            <Etiqueta tom={
              ativacao === null ? "atencao"
                : ativacao.ativo ? "ok"
                  : ativacao.podeAtivar ? "info" : "atencao"
            }>
              {ativacao === null ? "Rascunho"
                : ativacao.ativo ? "Ativo"
                  : ativacao.podeAtivar ? "Pronto para ativar" : "Rascunho"}
            </Etiqueta>
            {([
              ["IA", ativacao?.modelo ?? "—"],
              ["Ferramentas", String(ativacao?.ferramentas.length ?? 0)],
              ["Skills", String(skillsDoAgente.length)],
              ["Memória", ativacao?.memoriaAtiva === true
                ? "automática"
                : memorias.some((m) => m.ativo) ? "fixadas" : "desligada"],
              ["Arquivos", String(fontes.length)],
              ["Permissões",
                (ativacao?.ferramentas.length ?? 0) === 0 ? "—"
                  : ativacao?.ferramentas.every((f) => f.completo) ? "configuradas" : "atenção"],
              ["Modo", "Manual"],
            ] as const).map(([k, v]) => (
              <div key={k} style={{
                display: "flex", justifyContent: "space-between", gap: ESPACO.sm,
              }}>
                <span style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>{k}</span>
                <span style={{ fontSize: TAMANHO.miudo, color: CROMO.texto }}>{v}</span>
              </div>
            ))}
          </div>
        </Cartao>
      </aside>

      <CriarSkill
        aberto={criarSkillAberto}
        aoFechar={() => setCriarSkillAberto(false)}
        aoCriar={async (skillId) => {
          setCriarSkillAberto(false);
          await vincularSkill(skillId);
        }}
      />
    </div>
  );
}

// ─── Criar Skill ──────────────────────────────────────────────────────

/**
 * O formulario de criar Skill.
 *
 * Pede TRES coisas que uma pessoa sabe responder. Slug, versao,
 * manifesto e hash nao aparecem: quem os deriva e
 * `lib/agentes/skills/compor.ts`, e quem valida e o formato de Skill que
 * a F6 ja provou. Esta tela nao reimplementa nenhum dos dois.
 */
function CriarSkill({
  aberto, aoFechar, aoCriar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  aoCriar: (skillId: string) => Promise<void>;
}) {
  const [nome, setNome] = useState("");
  const [quando, setQuando] = useState("");
  const [instrucoes, setInstrucoes] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const r = await criarSkillDoDono({ nome, quandoUsar: quando, instrucoes });
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível salvar a Skill."));
        return;
      }
      setNome(""); setQuando(""); setInstrucoes("");
      await aoCriar(r.dados.skillId);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <PainelLateral aberto={aberto} titulo="Criar Skill" aoFechar={aoFechar}>
      {erro !== null && <Aviso tom="erro">{erro}</Aviso>}
      <Campo rotulo="Nome" valor={nome} aoMudar={setNome} obrigatorio
        placeholder="Ex.: Fechamento financeiro" maxLength={120} />
      <AreaTexto rotulo="Quando usar" valor={quando} aoMudar={setQuando} obrigatorio linhas={3}
        ajuda="Uma situação por linha."
        placeholder={"quando eu pedir resumo do mês\nquando eu perguntar sobre saldo"} />
      <AreaTexto rotulo="Instruções da Skill" valor={instrucoes} aoMudar={setInstrucoes}
        obrigatorio linhas={10}
        ajuda="Como o agente deve executar esta especialidade."
        placeholder="Ex.: Saldo = total de entradas menos total de saídas." />
      <Botao tom="primario" largura="cheia"
        desabilitado={salvando || nome.trim() === "" || instrucoes.trim() === ""}
        onClick={() => void salvar()}>
        {salvando ? "Salvando..." : "Salvar e adicionar ao agente"}
      </Botao>
    </PainelLateral>
  );
}
