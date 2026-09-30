"use client";

/**
 * O CHAT do agente — F7b.1.
 *
 * Usado em DOIS lugares, de proposito: a etapa "Testar" do wizard e o
 * workspace do agente. Sao a mesma conversa, com o mesmo runtime — a
 * unica diferenca e a moldura. Dois componentes divergiriam, e o "testei
 * e funcionou, mas no chat nao funciona" viria de graca.
 *
 * ── O que este componente NAO faz ───────────────────────────────────
 *
 * Nao monta prompt, nao escolhe modelo, nao decide permissao, nao le
 * arquivo e NAO FALA COM A REDE. Toda chamada passa por
 * `lib/ia/agentes-http.ts`, o unico ponto de rede da area; aqui ficam o
 * estado da tela e o desenho. Toda decisao vive no servidor, onde o
 * guard esta.
 *
 * ── Erro tecnico nao vira experiencia ───────────────────────────────
 *
 * `bloqueado_por_ferramenta`, `permissao_ausente` e companhia sao
 * traduzidos em `FRASES`. O codigo continua visivel em "detalhes
 * tecnicos" — escondê-lo do operador seria a outra metade do erro.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";
import { packDaFuncao } from "@/lib/agentes/factory/catalogo-ui";
import {
  Aviso, Botao, Etiqueta, PainelLateral, TAMANHO,
} from "@/components/ui/Primitivas";
import {
  criarConversaDoChat, decidirAprovacaoNoChat, enviarFonteDoAgente,
  enviarNaConversaDoChat, lerConversaDoChat, listarFontesDoAgente,
  type AnexoDaConversaUI, type AprovacaoPendenteUI, type FonteDoAgenteUI,
  type MensagemDoChatUI, type PassoDoChatUI, type RespostaDaFactory,
} from "@/lib/ia/agentes-http";

/**
 * Codigo tecnico -> frase humana.
 *
 * O §35/§44 pede isto, e a razao e concreta: "permissao_ausente" nao diz
 * a ninguem o que fazer, e "Configure as permissoes" diz.
 */
const FRASES: Record<string, string> = {
  bloqueado_por_ferramenta:
    "Não consegui concluir porque uma ferramenta ou fonte necessária não está disponível para este agente.",
  teto_de_passos:
    "A tarefa exigiu mais passos do que o limite. Tente pedir em partes menores.",
  provedor_indisponivel: "A IA não respondeu agora. Tente de novo em instantes.",
  mensagem_vazia: "Escreva uma mensagem.",
  mensagem_longa: "Mensagem muito longa. Para documentos, use uma fonte.",
  permissao_ausente: "Esta ferramenta ainda não tem permissão configurada.",
  permissao_bloqueada: "Esta ferramenta está bloqueada para este agente.",
  conexao_ausente: "Esta ferramenta precisa de uma conta conectada.",
  fonte_nao_configurada: "Adicione uma fonte para continuar.",
  arquivo_nao_encontrado: "Não encontrei este arquivo entre as fontes do agente.",
  aguardando_aprovacao: "Esta ação precisa da sua aprovação antes de rodar.",
  arquivo_grande: "Este arquivo passa do limite de 5 MB.",
  tipo_nao_suportado: "Só aceito planilhas .xlsx e .csv.",
};

function frase(codigo: string | null): string | null {
  return codigo === null ? null : (FRASES[codigo] ?? null);
}

/** Frase para os desfechos que nao sao `ok`, sem vazar detalhe interno. */
function frasePorEstado(r: RespostaDaFactory<unknown>, padrao: string): string {
  if (r.estado === "nao_autenticado") return "Sua sessão expirou. Entre novamente.";
  if (r.estado === "nao_encontrado") return "Isto não foi encontrado.";
  if (r.estado === "recusado") return frase(r.codigo) ?? r.mensagem;
  return padrao;
}

/**
 * Desfechos de passo que FECHARAM o turno, espelhando
 * `DESFECHOS_QUE_FECHAM` do runtime.
 *
 * A lista e repetida aqui de proposito, e nao importada: aquele modulo
 * e do servidor, e o que a tela precisa e reconhecer o desfecho que
 * chegou na resposta, nao decidir se ele fecha. Quem decidiu foi o
 * runtime; isto e leitura.
 */
const DESFECHOS_DE_BLOQUEIO = [
  "negado", "aguardando_aprovacao", "aprovacao_indisponivel",
  "indisponivel", "falha_auditoria", "nome_invalido",
];

/**
 * O passo que barrou o turno, se houve um.
 *
 * O `motivo` que a rota devolve diz `bloqueado_por_ferramenta` para
 * TODOS os fechamentos — falta de permissao, bloqueio explicito, fonte
 * ausente e espera de aprovacao chegam com a mesma palavra. A distincao
 * sobrevive nos PASSOS, em `desfecho`, e e de la que ela e lida: sem
 * isso, "precisa da sua aprovacao" apareceria como erro generico.
 */
function passoQueBarrou(m: MensagemDoChatUI | undefined): PassoDoChatUI | null {
  if (m === undefined) return null;
  for (let i = m.passos.length - 1; i >= 0; i--) {
    const p = m.passos[i];
    if (!p.executou && DESFECHOS_DE_BLOQUEIO.includes(p.desfecho)) return p;
  }
  return null;
}

export function ChatDoAgente({
  agenteId, conversaId, modoTeste = false, aoTrocarConversa,
}: {
  agenteId: string;
  conversaId: string | null;
  /** Na etapa Testar: deixa claro que nada aqui ativa o agente. */
  modoTeste?: boolean;
  aoTrocarConversa?: (id: string) => void;
}) {
  const [mensagens, setMensagens] = useState<readonly MensagemDoChatUI[]>([]);
  const [rascunho, setRascunho] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [codigoTecnico, setCodigoTecnico] = useState<string | null>(null);
  const [conversa, setConversa] = useState<string | null>(conversaId);
  const [menuMais, setMenuMais] = useState(false);
  const [fontes, setFontes] = useState<readonly FonteDoAgenteUI[]>([]);
  const [anexos, setAnexos] = useState<readonly AnexoDaConversaUI[]>([]);
  const [painelFontes, setPainelFontes] = useState(false);
  const [pendenteDeProposito, setPendenteDeProposito] = useState<string | null>(null);
  const [provenienciaDe, setProvenienciaDe] = useState<MensagemDoChatUI | null>(null);
  /**
   * A aprovacao viva desta conversa — F7b.4.4 §11.
   *
   * Vem do SERVIDOR a cada carregamento. Guardar isto so na memoria da
   * tela faria o cartao sumir num refresh, e o chat voltaria a parecer
   * travado sem explicacao.
   */
  const [aprovacao, setAprovacao] = useState<AprovacaoPendenteUI | null>(null);
  /** `aprovar` | `rejeitar` enquanto a decisao esta em voo. */
  const [decidindo, setDecidindo] = useState<string | null>(null);
  const fimRef = useRef<HTMLDivElement | null>(null);

  const carregarFontes = useCallback(async (cid: string | null) => {
    const r = await listarFontesDoAgente(agenteId, cid);
    if (r.estado !== "ok") return;
    setFontes(r.dados.fontes);
    setAnexos(r.dados.anexos);
  }, [agenteId]);

  const carregarMensagens = useCallback(async (cid: string) => {
    const r = await lerConversaDoChat(agenteId, cid);
    if (r.estado !== "ok") return;
    setMensagens(r.dados.mensagens);
    setAprovacao(r.dados.aprovacaoPendente);
  }, [agenteId]);

  /**
   * Decide a aprovacao SEM sair da tela — F7b.4.4 §10/§21.
   *
   * ── O que este fluxo NAO faz, e por que ──────────────────────────
   *
   * Nao navega, nao recarrega a rota, nao refaz a conversa do zero e nao
   * limpa `mensagens`. A causa do "chat resetou" que o Rodrigo viu era um
   * `Link` para `/ia/aprovacoes`: a pessoa saia da pagina, o componente
   * desmontava, e ao voltar o estado local tinha ido junto. Nada apagou
   * as mensagens — a tela foi embora.
   *
   * Aqui a resposta do servidor e ACRESCENTADA ao que ja esta na tela. As
   * mensagens anteriores nao sao tocadas.
   */
  async function decidir(decisao: "aprovar" | "rejeitar") {
    if (aprovacao === null || decidindo !== null) return;
    setErro(null);
    setCodigoTecnico(null);
    // A trava e o proprio estado: enquanto ha decisao em voo, o segundo
    // clique nao chega ao servidor. E defesa de UX, nao de correcao — a
    // correcao esta no banco, que consome a aprovacao atomicamente.
    setDecidindo(decisao);
    try {
      const r = await decidirAprovacaoNoChat(agenteId, aprovacao.aprovacaoId, decisao);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível registrar a decisão."));
        return;
      }
      // A aprovacao sai do ar porque foi decidida — e nao porque a tela
      // adivinhou. O `null` aqui casa com o que o servidor devolveria num
      // refresh agora.
      setAprovacao(null);
      if (r.dados.mensagem !== null) {
        setMensagens((atual) => [...atual, r.dados.mensagem as MensagemDoChatUI]);
      } else if (r.dados.jaExecutada) {
        // Segundo clique: a acao ja rodou e a resposta ja esta na
        // conversa. Recarregar e o jeito honesto de mostrar o que existe.
        if (conversa !== null) await carregarMensagens(conversa);
      }
    } finally {
      setDecidindo(null);
    }
  }

  // Abre conversa se ainda nao houver. Uma conversa vazia nao custa
  // nada e evita o estado "digitei e nao tinha onde gravar".
  useEffect(() => {
    let vivo = true;
    (async () => {
      let cid = conversa;
      if (cid === null) {
        const r = await criarConversaDoChat(agenteId);
        if (r.estado !== "ok") {
          if (vivo) setErro(frasePorEstado(r, "Não foi possível abrir a conversa."));
          return;
        }
        cid = r.dados.id;
        if (vivo) { setConversa(cid); aoTrocarConversa?.(cid); }
      }
      if (vivo && cid !== null) {
        await carregarMensagens(cid);
        await carregarFontes(cid);
      }
    })();
    return () => { vivo = false; };
  }, [agenteId, conversa, carregarMensagens, carregarFontes, aoTrocarConversa]);

  useEffect(() => { fimRef.current?.scrollIntoView({ behavior: "smooth" }); }, [mensagens]);

  async function enviar() {
    const texto = rascunho.trim();
    if (texto === "" || enviando || conversa === null) return;
    setEnviando(true);
    setErro(null);
    setCodigoTecnico(null);
    setRascunho("");

    const r = await enviarNaConversaDoChat(agenteId, conversa, texto);
    setEnviando(false);

    if (r.estado !== "ok") {
      setCodigoTecnico(r.estado === "recusado" ? r.codigo : null);
      setErro(frasePorEstado(r, "Não foi possível enviar."));
      // O texto volta para o campo: ninguem perde o que escreveu porque
      // a rede caiu.
      setRascunho(texto);
      return;
    }

    // As DUAS mensagens vem do servidor. A tela nao inventa a sua
    // propria versao do que foi gravado.
    setMensagens((atual) => [...atual, r.dados.mensagemDoUsuario, r.dados.resposta]);

    // Turno gravado, mas interrompido: a resposta existe e merece ser
    // mostrada — junto com o motivo pelo qual parou ali.
    if (r.dados.motivo !== null && r.dados.motivo !== "concluido") {
      setCodigoTecnico(r.dados.motivo);
      setErro(frase(r.dados.motivo) ?? "O agente não conseguiu concluir.");
    }
  }

  async function subirArquivo(escopo: "agente" | "conversa", arquivo: File) {
    setMenuMais(false);
    setErro(null);
    setCodigoTecnico(null);

    const r = await enviarFonteDoAgente(agenteId, arquivo, escopo, conversa);
    if (r.estado !== "ok") {
      setCodigoTecnico(r.estado === "recusado" ? r.codigo : null);
      setErro(frasePorEstado(r, "Não foi possível enviar o arquivo."));
      return;
    }
    // Anexo de conversa nao precisa de proposito: ele vale para esta
    // conversa, e o contexto dela ja diz para que serve. Arquivo que FICA
    // no agente precisa — e sem `papel` o agente nao consegue distinguir
    // duas planilhas parecidas. O chat nao pergunta aqui (quem anexa no
    // meio de uma conversa quer anexar, nao preencher formulario); ele
    // avisa onde a pergunta e feita.
    if (escopo === "agente") setPendenteDeProposito(r.dados.nome);
    await carregarFontes(conversa);
  }

  function escolherArquivo(escopo: "agente" | "conversa") {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.csv";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void subirArquivo(escopo, f);
    };
    input.click();
  }

  // Lido da ULTIMA mensagem do agente: e o turno que a pessoa acabou de
  // ver, e e sobre ele que o cartao fala.
  const barrado = passoQueBarrou(
    [...mensagens].reverse().find((m) => m.papel === "assistente"));

  /** O nome de gente do pack. `null` quando a Funcao nao esta em pack
   *  nenhum — e ai o cartao nao inventa nome. */
  const nomeDoPack = (funcaoId: string): string | null =>
    packDaFuncao(funcaoId)?.nome ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420 }}>
      {modoTeste && (
        <div style={{ marginBottom: ESPACO.md }}>
          <Aviso tom="info">
            <strong>Modo de teste.</strong> Você está conversando com o agente antes de ativá-lo.
            Nada aqui liga o agente.
          </Aviso>
        </div>
      )}

      {/* Fontes de forma discreta, como o §41 pede. */}
      <div style={{
        display: "flex", gap: ESPACO.sm, alignItems: "center",
        marginBottom: ESPACO.md, flexWrap: "wrap",
      }}>
        <Botao tom="sutil" onClick={() => setPainelFontes(true)}>
          Arquivos {fontes.length}
        </Botao>
        {anexos.length > 0 && (
          <Etiqueta tom="info">{anexos.length} nesta conversa</Etiqueta>
        )}
      </div>

      {pendenteDeProposito !== null && (
        <div style={{ marginBottom: ESPACO.md }}>
          <Aviso tom="info">
            <strong>{pendenteDeProposito}</strong> foi adicionado a este agente. Descreva o que
            ele representa em <strong>Configurar → Arquivos</strong>, senão o agente não conseguirá
            diferenciá-lo de outros arquivos parecidos.
          </Aviso>
        </div>
      )}

      <div style={{
        flex: 1, overflowY: "auto", display: "flex", flexDirection: "column",
        gap: ESPACO.md, paddingRight: ESPACO.xs,
      }}>
        {mensagens.length === 0 && (
          <p style={{ color: CROMO.textoFraco, fontSize: TAMANHO.corpo, margin: 0 }}>
            Nenhuma mensagem ainda. Escreva abaixo para começar.
          </p>
        )}
        {mensagens.map((m) => (
          <div
            key={m.id}
            style={{
              alignSelf: m.papel === "usuario" ? "flex-end" : "flex-start",
              maxWidth: "min(720px, 88%)",
              background: m.papel === "usuario" ? CROMO.acentoFundo : CROMO.fundoCard,
              border: `1px solid ${m.papel === "usuario" ? CROMO.acentoBorda : CROMO.borda}`,
              borderRadius: RAIO.card,
              padding: ESPACO.md,
            }}
          >
            <div style={{
              fontSize: TAMANHO.miudo, color: CROMO.textoFraco, marginBottom: 4,
            }}>
              {m.papel === "usuario" ? "Você" : "Agente"}
            </div>
            <div style={{
              fontSize: TAMANHO.corpo, color: CROMO.texto, whiteSpace: "pre-wrap",
              lineHeight: 1.55,
            }}>
              {m.conteudo}
            </div>
            {m.passos.length > 0 && (
              <div style={{ marginTop: ESPACO.sm }}>
                <Botao tom="sutil" onClick={() => setProvenienciaDe(m)}>
                  Ver dados usados
                </Botao>
              </div>
            )}
          </div>
        ))}
        <div ref={fimRef} />
      </div>

      {/* ── O cartao de APROVACAO ──────────────────────────────────
          Nivel `aprovacao` nao e falha: o agente parou porque tem de
          parar, e alguem precisa decidir. Mostrar isso como erro faria
          o dono achar que quebrou.

          O cartao NAO tem "Aprovar" aqui dentro, e isso e deliberado.
          A aprovacao que existe hoje e de TAREFA, com fila e retomada
          proprias (`/ia/aprovacoes`); um botao nesta tela gravaria uma
          decisao que nenhuma conversa retomaria — pareceria ter
          funcionado e nao teria. O caminho e o de verdade. */}
      {aprovacao !== null && (
        <div style={{
          marginTop: ESPACO.md, padding: ESPACO.md,
          border: `1px solid ${CROMO.acentoBorda}`, borderRadius: RAIO.card,
          background: CROMO.acentoFundo,
        }}>
          <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
            Esta ação precisa da sua aprovação
          </strong>
          <p style={{
            margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
            fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
          }}>
            {barrado === null || nomeDoPack(barrado.funcaoId) === null
              ? "O agente parou antes de executar, como você configurou."
              : `O agente precisou de ${nomeDoPack(barrado.funcaoId)} e parou antes de usar, como você configurou.`}
            {" "}Ao aprovar, ele continua daqui — você não precisa repetir a pergunta.
          </p>
          <div style={{ display: "flex", gap: ESPACO.sm, flexWrap: "wrap" }}>
            <Botao tom="primario" desabilitado={decidindo !== null}
              onClick={() => void decidir("aprovar")}>
              {decidindo === "aprovar" ? "Executando..." : "Aprovar e continuar"}
            </Botao>
            <Botao tom="secundario" desabilitado={decidindo !== null}
              onClick={() => void decidir("rejeitar")}>
              {decidindo === "rejeitar" ? "Registrando..." : "Não autorizar"}
            </Botao>
          </div>
          <details style={{ marginTop: ESPACO.sm }}>
            <summary style={{
              cursor: "pointer", fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
            }}>
              Detalhes técnicos
            </summary>
            <code style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
              {barrado === null ? aprovacao.estado : `${barrado.funcaoId} · ${aprovacao.estado}`}
            </code>
          </details>
        </div>
      )}

      {erro !== null && barrado?.desfecho !== "aguardando_aprovacao" && (
        <div style={{ marginTop: ESPACO.md }}>
          <Aviso tom="atencao">
            {erro}
            {codigoTecnico !== null && (
              <details style={{ marginTop: ESPACO.xs }}>
                <summary style={{ cursor: "pointer", fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                  Detalhes técnicos
                </summary>
                <code style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                  {codigoTecnico}
                </code>
              </details>
            )}
          </Aviso>
        </div>
      )}

      {/* Rodape: [+] campo [Enviar] */}
      <div style={{
        marginTop: ESPACO.md, display: "flex", gap: ESPACO.sm, alignItems: "flex-end",
        position: "relative",
      }}>
        <Botao tom="secundario" onClick={() => setMenuMais((v) => !v)} titulo="Adicionar arquivo">
          +
        </Botao>

        {menuMais && (
          <div
            role="menu"
            style={{
              position: "absolute", bottom: "calc(100% + 8px)", left: 0, zIndex: 20,
              width: "min(360px, 90vw)", background: "#161a21",
              border: `1px solid ${CROMO.borda}`, borderRadius: RAIO.card,
              padding: ESPACO.md, display: "flex", flexDirection: "column", gap: ESPACO.sm,
            }}
          >
            <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
              Adicionar arquivo
            </strong>
            <button
              type="button" role="menuitem"
              onClick={() => escolherArquivo("conversa")}
              style={{
                textAlign: "left", background: "transparent", border: "none",
                padding: ESPACO.sm, borderRadius: RAIO.controle, cursor: "pointer",
                color: CROMO.texto, fontSize: TAMANHO.corpo,
              }}
            >
              Usar somente nesta conversa
              <span style={{ display: "block", fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                O arquivo fica disponível só neste chat.
              </span>
            </button>
            <button
              type="button" role="menuitem"
              onClick={() => escolherArquivo("agente")}
              style={{
                textAlign: "left", background: "transparent", border: "none",
                padding: ESPACO.sm, borderRadius: RAIO.controle, cursor: "pointer",
                color: CROMO.texto, fontSize: TAMANHO.corpo,
              }}
            >
              Manter neste agente
              <span style={{ display: "block", fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                Fica disponível também nas próximas conversas.
              </span>
            </button>
            <span style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
              Aceita .xlsx e .csv, até 5 MB.
            </span>
          </div>
        )}

        <textarea
          aria-label="Mensagem"
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={(e) => {
            // Enter envia; Shift+Enter quebra linha. Quem escreve texto
            // longo usa Shift, e quem escreve uma pergunta usa Enter.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void enviar(); }
          }}
          placeholder="Digite uma mensagem..."
          rows={2}
          style={{
            flex: 1, background: "rgba(0,0,0,0.25)",
            border: `1px solid ${CROMO.borda}`, borderRadius: RAIO.controle,
            padding: ESPACO.md, color: CROMO.texto, fontSize: TAMANHO.corpo,
            lineHeight: 1.5, resize: "vertical", fontFamily: "inherit", minHeight: 52,
          }}
        />
        <Botao tom="primario" onClick={() => void enviar()} desabilitado={enviando || rascunho.trim() === ""}>
          {enviando ? "Enviando..." : "Enviar"}
        </Botao>
      </div>

      <PainelLateral aberto={painelFontes} titulo="Arquivos" aoFechar={() => setPainelFontes(false)}>
        <div>
          <h3 style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, margin: `0 0 ${ESPACO.sm}px` }}>
            Do agente
          </h3>
          {fontes.length === 0 && (
            <p style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco, margin: 0 }}>
              Nenhum arquivo ainda.
            </p>
          )}
          {fontes.map((f) => (
            <div key={f.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: `${ESPACO.sm}px 0`, borderBottom: `1px solid ${CROMO.bordaSutil}`,
            }}>
              <span style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>{f.nome}</span>
              <Etiqueta>{f.papel ?? f.tipo}</Etiqueta>
            </div>
          ))}
        </div>
        {anexos.length > 0 && (
          <div>
            <h3 style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, margin: `0 0 ${ESPACO.sm}px` }}>
              Somente nesta conversa
            </h3>
            {anexos.map((f) => (
              <div key={f.id} style={{ padding: `${ESPACO.sm}px 0` }}>
                <span style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>{f.nome}</span>
                {"  "}
                <Etiqueta tom="info">Somente esta conversa</Etiqueta>
              </div>
            ))}
          </div>
        )}
      </PainelLateral>

      <PainelLateral
        aberto={provenienciaDe !== null}
        titulo="Dados usados"
        aoFechar={() => setProvenienciaDe(null)}
      >
        {provenienciaDe?.passos.map((p, i) => {
          // O `funcaoId` aparece SO aqui, no painel tecnico — e nunca
          // na conversa. Quem abre este painel quer o detalhe.
          const pack = p.funcaoId.split(".")[0];
          return (
            <div key={`${p.funcaoId}-${i}`} style={{
              borderBottom: `1px solid ${CROMO.bordaSutil}`, paddingBottom: ESPACO.md,
            }}>
              <div style={{ fontSize: TAMANHO.corpo, color: CROMO.texto, marginBottom: 4 }}>
                {pack}
              </div>
              <div style={{ display: "flex", gap: ESPACO.sm, flexWrap: "wrap" }}>
                <Etiqueta tom={p.executou ? "ok" : "atencao"}>
                  {p.executou ? "executou" : "não executou"}
                </Etiqueta>
                <Etiqueta>{p.desfecho}</Etiqueta>
              </div>
              <details style={{ marginTop: ESPACO.sm }}>
                <summary style={{ cursor: "pointer", fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                  Detalhes técnicos
                </summary>
                <code style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
                  {p.funcaoId}
                  {p.requestId !== null && ` · ${p.requestId}`}
                </code>
              </details>
            </div>
          );
        })}
        {provenienciaDe?.uso !== null && provenienciaDe?.uso !== undefined && (
          <div style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco }}>
            {provenienciaDe.modelo}
            {provenienciaDe.uso.tempoMs !== null && ` · ${provenienciaDe.uso.tempoMs} ms`}
          </div>
        )}
      </PainelLateral>
    </div>
  );
}
