"use client";

/**
 * ARQUIVOS E DADOS do agente — AGENT-FACTORY-F7b.3.
 *
 * ── Por que esta tela mudou ─────────────────────────────────────────
 *
 * Antes ela era "Fontes", e subir um arquivo terminava ali. O problema
 * nao era o nome: era que `papel` ficava vazio.
 *
 * `papel` e o campo que o MODELO le para saber que uma planilha e de
 * entradas e a outra de saidas (ver `montarContextoDeFontes`). Dois
 * arquivos sem papel chegam ao agente indistinguiveis — e ele entao
 * escolhe qual somar no escuro. Nao e um rotulo faltando; e a resposta
 * errada.
 *
 * ── A ordem das perguntas, e por que ela e essa ─────────────────────
 *
 * Subir  ->  INSPECIONAR  ->  perguntar.
 *
 * Perguntar antes de inspecionar e pedir para adivinhar: a pessoa acabou
 * de escolher um arquivo entre vinte e nao lembra o que tem dentro. Com
 * as abas, as linhas e os cabecalhos na tela, a pergunta fica
 * respondivel — e a sugestao de `papel` sai do nome e dos cabecalhos,
 * por regra deterministica, nunca por IA.
 *
 * ── A palavra "fonte" nao aparece ───────────────────────────────────
 *
 * No banco a tabela continua `agente_fontes`, e nenhuma migration foi
 * feita por causa de nomenclatura. Na tela a pessoa ve "arquivo", porque
 * e o que ela subiu.
 */
import { useCallback, useEffect, useState } from "react";

import { CROMO, ESPACO, RAIO } from "@/lib/ia/design";
import {
  AreaTexto, Aviso, Botao, Campo, Cartao, EscolhaUnica, Etiqueta,
  PainelLateral, TAMANHO,
} from "@/components/ui/Primitivas";
import {
  atualizarArquivoDoAgente, enviarFonteDoAgente, inspecionarArquivoDoAgente,
  listarFontesDoAgente,
  type FonteDoAgenteUI, type InspecaoDeArquivoUI, type RespostaDaFactory,
} from "@/lib/ia/agentes-http";
import { fraseDaSugestao, sugerirPapel } from "@/lib/agentes/factory/proposito-de-arquivo";

const EXTENSOES = ".xlsx,.csv";
const LIMITE_HUMANO = "Aceita .xlsx e .csv, até 5 MB.";

function frasePorEstado(r: RespostaDaFactory<unknown>, padrao: string): string {
  if (r.estado === "nao_autenticado") return "Sua sessão expirou. Entre novamente.";
  if (r.estado === "nao_encontrado") return "Este arquivo não foi encontrado.";
  if (r.estado === "recusado") return r.mensagem;
  return padrao;
}

function tamanhoLegivel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArquivosDoAgente({
  agenteId, aoMudar,
}: {
  agenteId: string;
  /** Avisa o wizard para ele atualizar o resumo lateral. */
  aoMudar?: () => void;
}) {
  const [arquivos, setArquivos] = useState<readonly FonteDoAgenteUI[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [subindo, setSubindo] = useState(false);

  // O painel de propósito, aberto logo depois do upload.
  const [inspecao, setInspecao] = useState<InspecaoDeArquivoUI | null>(null);
  const [papel, setPapel] = useState("");
  const [comoUsar, setComoUsar] = useState("");
  const [sugestao, setSugestao] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const recarregar = useCallback(async () => {
    const r = await listarFontesDoAgente(agenteId, null);
    if (r.estado === "ok") setArquivos(r.dados.fontes);
  }, [agenteId]);

  useEffect(() => { void recarregar(); }, [recarregar]);

  /** Abre o painel de propósito para um arquivo já persistido. */
  async function abrirProposito(fonteId: string) {
    setErro(null);
    const r = await inspecionarArquivoDoAgente(agenteId, fonteId);
    if (r.estado !== "ok") {
      setErro(frasePorEstado(r, "Não foi possível ler este arquivo."));
      return;
    }
    setInspecao(r.dados);
    // Já respondido antes vence a sugestão: reabrir a tela não pode
    // sobrescrever o que a pessoa escreveu.
    const cabecalhos = r.dados.abas.flatMap((a) => a.cabecalhos);
    const palpite = sugerirPapel({ nome: r.dados.nome, cabecalhos });
    setPapel(r.dados.papel ?? palpite ?? "");
    setComoUsar(r.dados.descricao ?? "");
    setSugestao(r.dados.papel === null ? fraseDaSugestao(palpite) : null);
  }

  async function subir(arquivo: File) {
    setErro(null);
    setSubindo(true);
    try {
      // Sobe SEM propósito. Ele é perguntado depois, com a inspeção na
      // tela — e é por isso que existe o PATCH de metadado.
      const r = await enviarFonteDoAgente(agenteId, arquivo, "agente", null);
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível enviar o arquivo."));
        return;
      }
      await recarregar();
      aoMudar?.();
      await abrirProposito(r.dados.id);
    } finally {
      setSubindo(false);
    }
  }

  function escolher() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = EXTENSOES;
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void subir(f);
    };
    input.click();
  }

  async function salvarProposito() {
    if (inspecao === null) return;
    setErro(null);
    setSalvando(true);
    try {
      const r = await atualizarArquivoDoAgente(agenteId, inspecao.id, {
        // Vazio limpa: `null` é pedido legítimo, e a rota o aceita.
        papel: papel.trim() === "" ? null : papel.trim(),
        descricao: comoUsar.trim() === "" ? null : comoUsar.trim(),
      });
      if (r.estado !== "ok") {
        setErro(frasePorEstado(r, "Não foi possível salvar."));
        return;
      }
      setInspecao(null);
      await recarregar();
      aoMudar?.();
    } finally {
      setSalvando(false);
    }
  }

  return (
    <>
      <p style={{ margin: 0, fontSize: TAMANHO.corpo, color: CROMO.textoFraco }}>
        Arquivos que este agente poderá consultar. {LIMITE_HUMANO}
      </p>

      {erro !== null && <Aviso tom="erro">{erro}</Aviso>}

      <Botao tom="primario" desabilitado={subindo} onClick={escolher}>
        {subindo ? "Enviando..." : "+ Adicionar arquivo"}
      </Botao>

      {arquivos.length === 0 && (
        <p style={{ fontSize: TAMANHO.miudo, color: CROMO.textoFraco, margin: 0 }}>
          Nenhum arquivo ainda.
        </p>
      )}

      {arquivos.map((f) => (
        <Cartao key={f.id}>
          <div style={{
            display: "flex", justifyContent: "space-between",
            gap: ESPACO.md, flexWrap: "wrap", alignItems: "flex-start",
          }}>
            <div style={{ minWidth: 0 }}>
              <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                {f.nome}
              </strong>
              {/* O que ele É vem primeiro, porque é o que o agente usa
                  para escolher o arquivo certo. */}
              <p style={{
                margin: `${ESPACO.xs}px 0 0`,
                fontSize: TAMANHO.miudo,
                color: f.papel === null ? "#ffcc7a" : CROMO.textoFraco,
              }}>
                {f.papel ?? "Sem descrição do que representa — o agente não saberá diferenciar."}
              </p>
              {f.descricao !== null && (
                <p style={{
                  margin: `${ESPACO.xs}px 0 0`, fontSize: TAMANHO.miudo,
                  color: CROMO.textoFraco,
                }}>
                  {f.descricao}
                </p>
              )}
              <div style={{ display: "flex", gap: ESPACO.xs, marginTop: ESPACO.sm }}>
                <Etiqueta>{f.tipo}</Etiqueta>
                <Etiqueta tom="info">Sempre disponível</Etiqueta>
              </div>
            </div>
            <div style={{ display: "flex", gap: ESPACO.xs, flexShrink: 0 }}>
              <Botao tom="secundario" onClick={() => void abrirProposito(f.id)}>
                Ver e descrever
              </Botao>
            </div>
          </div>
        </Cartao>
      ))}

      {/* ── O painel de propósito ── */}
      <PainelLateral
        aberto={inspecao !== null}
        titulo="Sobre este arquivo"
        aoFechar={() => setInspecao(null)}
      >
        {inspecao !== null && (
          <>
            <Cartao>
              <strong style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                {inspecao.nome}
              </strong>
              <p style={{
                margin: `${ESPACO.xs}px 0 ${ESPACO.sm}px`,
                fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
              }}>
                {inspecao.tipo.toUpperCase()} · {tamanhoLegivel(inspecao.tamanhoBytes)}
                {" · "}
                {inspecao.abas.length === 1 ? "1 aba" : `${inspecao.abas.length} abas`}
              </p>

              {inspecao.abas.map((aba) => (
                <div key={aba.nome} style={{
                  padding: `${ESPACO.sm}px 0`,
                  borderTop: `1px solid ${CROMO.bordaSutil}`,
                }}>
                  <div style={{ fontSize: TAMANHO.corpo, color: CROMO.texto }}>
                    {aba.nome}
                  </div>
                  <div style={{
                    fontSize: TAMANHO.miudo, color: CROMO.textoFraco, marginTop: 2,
                  }}>
                    {aba.linhas} linha(s) · {aba.colunas} coluna(s)
                  </div>
                  {aba.cabecalhos.length > 0 && (
                    <div style={{
                      fontSize: TAMANHO.miudo, color: CROMO.textoFraco,
                      marginTop: ESPACO.xs, lineHeight: 1.5,
                    }}>
                      Colunas: {aba.cabecalhos.join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </Cartao>

            {/* Os avisos vêm do mesmo inspetor que responde ao modelo.
                Fórmula não recalculada e texto que começa por = + - @ são
                coisas que mudam o que a pessoa vai escrever abaixo. */}
            {inspecao.avisos.map((a) => (
              <Aviso key={a} tom="info">{a}</Aviso>
            ))}

            <Campo
              rotulo="O que este arquivo representa?"
              valor={papel}
              aoMudar={(v) => { setPapel(v); setSugestao(null); }}
              placeholder="Ex.: Entradas financeiras"
              ajuda={sugestao ?? "O agente usa isto para saber qual arquivo consultar."}
              maxLength={120}
            />

            <AreaTexto
              rotulo="Como este agente deve usar este arquivo?"
              valor={comoUsar}
              aoMudar={setComoUsar}
              linhas={3}
              placeholder="Ex.: Consultar recebimentos para calcular as entradas do mês."
              ajuda="Isto orienta o agente. Não dá nem tira permissão."
              maxLength={500}
            />

            {/* Escopo é read-only aqui: quem entra por esta tela está
                configurando o AGENTE. Anexo de conversa nasce no chat,
                pelo [+], e é lá que a escolha faz sentido. */}
            <EscolhaUnica
              rotulo="Onde usar?"
              opcoes={[{
                valor: "agente" as const,
                rotulo: "Sempre disponível para este agente",
                ajuda: "Para usar só numa conversa, anexe pelo + dentro do chat.",
              }]}
              valor="agente"
              aoMudar={() => undefined}
            />

            <Botao tom="primario" largura="cheia"
              desabilitado={salvando} onClick={() => void salvarProposito()}>
              {salvando ? "Salvando..." : "Salvar"}
            </Botao>
          </>
        )}
      </PainelLateral>
    </>
  );
}
