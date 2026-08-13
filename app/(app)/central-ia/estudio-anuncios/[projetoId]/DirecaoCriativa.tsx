"use client";

/**
 * Direção criativa do ensaio + instrução por imagem (2026-09-04).
 *
 * ── Por que esta tela existe ────────────────────────────────────────
 * No primeiro E2E real, as imagens saíram com "cara de IA" e sem
 * estratégia comercial distinta entre elas. A auditoria mostrou que o
 * usuário não tinha ONDE dizer o que queria: a etapa de planejamento
 * recebia só a análise visual e a configuração do projeto. Mesma classe
 * de defeito dos atributos do Mercado Livre — o servidor sabia receber,
 * a tela não sabia pedir.
 *
 * ── Decisões de comportamento ───────────────────────────────────────
 * **A quantidade de campos segue o projeto, nunca um número fixo.** Se
 * o projeto pede 6 imagens, aparecem 6 campos. Hardcodar 4 foi
 * explicitamente proibido.
 *
 * **Campo vazio é resposta válida**, e significa "a IA decide a melhor
 * estratégia para esta imagem" — não é pendência, então nada aqui é
 * marcado como obrigatório nem bloqueia o fluxo.
 *
 * **O texto do usuário NUNCA vira prompt bruto.** Ele é direção
 * criativa: a etapa `geracao_prompts_imagem` o interpreta junto da
 * verdade visual confirmada e monta a cena. Isso está dito na tela para
 * a expectativa ficar correta — quem escreve "fundo marrom" recebe uma
 * cena coerente, não aquelas duas palavras repassadas ao gerador.
 *
 * Só é editável enquanto a geração não começou: depois que o pipeline
 * roda, mudar a direção não mudaria as imagens já criadas, e um campo
 * que aceita edição sem efeito é pior que um campo desabilitado.
 */
import { useState } from "react";

const rotulo: React.CSSProperties = {
  display: "block", fontSize: "11px", fontWeight: 700, color: "#9099aa",
  textTransform: "uppercase", letterSpacing: "0.4px", marginBottom: "6px",
};
const campoBase: React.CSSProperties = {
  width: "100%", padding: "9px 11px", borderRadius: "8px", fontSize: "13px",
  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.14)",
  color: "#fff", boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.5,
};

const MAX_GERAL = 2000;
const MAX_IMAGEM = 500;

export function DirecaoCriativa({
  projetoId, quantidade, direcaoInicial, direcoesInicial, editavel, onSalvo,
}: {
  projetoId: string;
  quantidade: number;
  direcaoInicial: string | null;
  direcoesInicial: string[] | null;
  /** Falso depois que a geração começou — ver nota no cabeçalho. */
  editavel: boolean;
  onSalvo: () => void | Promise<void>;
}) {
  const [geral, setGeral] = useState(direcaoInicial ?? "");
  // Sempre exatamente `quantidade` posições: o array salvo pode ter
  // outro tamanho se a quantidade mudou depois de escrito.
  const [porImagem, setPorImagem] = useState<string[]>(() =>
    Array.from({ length: quantidade }, (_, i) => direcoesInicial?.[i] ?? "")
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fetch(`/api/estudio-anuncios/projetos/${projetoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          direcao_criativa: geral.trim() === "" ? null : geral.trim(),
          // Envia o array inteiro, inclusive posições vazias: ele é
          // POSICIONAL, e filtrar os vazios deslocaria a instrução da
          // imagem 4 para a imagem 2.
          direcoes_imagens: porImagem.every(d => d.trim() === "") ? null : porImagem.map(d => d.trim()),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErro(data?.erro || "Não foi possível salvar a direção criativa.");
        return;
      }
      setAviso("Direção criativa salva.");
      await onSalvo();
    } catch {
      setErro("Falha de conexão ao salvar.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div>
      <p style={{ fontSize: "12px", color: "#9099aa", margin: "0 0 14px", lineHeight: 1.6 }}>
        Tudo aqui é <strong style={{ color: "#cdd3dd" }}>opcional</strong>. O que você escrever é usado como
        direção criativa — a IA interpreta junto com o que foi confirmado nas suas fotos e monta a cena.
        Não é copiado literalmente para o gerador de imagens.
      </p>

      <div style={{ marginBottom: "18px" }}>
        <label style={rotulo}>Direção geral do ensaio</label>
        <textarea
          style={{ ...campoBase, minHeight: "76px", resize: "vertical" }}
          value={geral}
          onChange={e => setGeral(e.target.value)}
          disabled={!editavel}
          maxLength={MAX_GERAL}
          placeholder="Ex.: anúncio sofisticado, tons marrons e creme, aparência premium e elegante."
        />
        <div style={{ fontSize: "10.5px", color: "#6b7385", marginTop: "4px", textAlign: "right" }}>
          {geral.length}/{MAX_GERAL}
        </div>
      </div>

      <label style={rotulo}>Planejamento das imagens</label>
      <p style={{ fontSize: "11.5px", color: "#9099aa", margin: "0 0 10px", lineHeight: 1.5 }}>
        Opcional. Descreva o que você gostaria nesta imagem. Se deixar em branco, a IA decidirá a melhor
        estratégia para o anúncio.
      </p>
      <div style={{ display: "grid", gap: "10px" }}>
        {porImagem.map((valor, i) => (
          <div key={i}>
            <label style={{ ...rotulo, textTransform: "none", fontSize: "11.5px", marginBottom: "4px" }}>
              Imagem {i + 1}
              {i === 0 && (
                <span style={{ color: "#6b7385", fontWeight: 600 }}> — capa do anúncio</span>
              )}
            </label>
            <input
              style={campoBase}
              value={valor}
              onChange={e => setPorImagem(p => p.map((v, j) => (j === i ? e.target.value : v)))}
              disabled={!editavel}
              maxLength={MAX_IMAGEM}
              placeholder={i === 0
                ? "Ex.: os cinco produtos juntos, fundo claro, composição premium."
                : "Em branco = a IA decide"}
            />
          </div>
        ))}
      </div>

      {erro && (
        <p style={{ fontSize: "12px", color: "#ff6b6b", margin: "12px 0 0" }}>{erro}</p>
      )}
      {aviso && (
        <p style={{ fontSize: "12px", color: "#4ade80", margin: "12px 0 0" }}>{aviso}</p>
      )}

      {editavel ? (
        <button
          type="button"
          onClick={salvar}
          disabled={salvando}
          style={{
            marginTop: "14px", padding: "9px 18px", borderRadius: "9px", border: "none",
            fontSize: "13px", fontWeight: 800, cursor: salvando ? "default" : "pointer",
            background: salvando ? "rgba(255,255,255,0.12)" : "#7c5cff", color: "#fff",
          }}
        >
          {salvando ? "Salvando..." : "Salvar direção criativa"}
        </button>
      ) : (
        <p style={{ fontSize: "11.5px", color: "#6b7385", margin: "14px 0 0", lineHeight: 1.5 }}>
          A geração já começou, então a direção criativa ficou travada — alterá-la agora não mudaria as
          imagens que já foram planejadas.
        </p>
      )}
    </div>
  );
}
